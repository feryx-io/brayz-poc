import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * Turns that change the order should cost one model round trip, not two.
 *
 * Measured on the call of 2026-09-02 16:14, a one-word answer ("Large.") spent
 * 2483 ms deciding to call add_item and another 1503 ms saying what it had
 * done — and the caller heard nothing at all until the second one finished.
 * The second trip only rephrases what the first already knew it was doing.
 */
class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    opts.onAudio(new Uint8Array(320));
  }
}

interface Step {
  text?: string;
  tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

class ScriptedLlm implements LlmProvider {
  readonly name = 'fake-llm';
  script: Step[] = [];
  requests = 0;
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const step = this.script[this.requests] ?? { text: 'Anything else?' };
    this.requests += 1;
    // Text first, then the tool call — the shape the prompt now asks for.
    if (step.text) opts.onEvent({ type: 'text', textDelta: step.text });
    for (const [i, t] of (step.tools ?? []).entries()) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: `t${this.requests}-${i}`, name: t.name, arguments: t.arguments ?? {} },
      });
    }
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [
  {
    id: 'mi-wings',
    name: 'Boneless Wings',
    category: 'Sides',
    priceCents: 1250,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: [
          { id: 'm-bbq', name: 'BBQ', priceCents: 0 },
          { id: 'm-buf', name: 'Buffalo (Hot)', priceCents: 0 },
        ],
      },
    ],
  },
];

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine(orderAckMode: 'fast' | 'natural' = 'fast') {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const tts = new FakeTts();
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-1rt', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ name: "Mario's", orderAckMode }),
    toolExecutor: async () => 'We are open until nine.',
  });
  return { engine, stt, llm, tts };
}

/** Run one caller utterance and let anything it triggers settle. */
async function say(
  engine: ConversationEngine,
  stt: FakeStt,
  llm: ScriptedLlm,
  text: string,
): Promise<void> {
  const before = llm.requests;
  stt.onSegment!({ text, isFinal: true });
  await waitFor(() => llm.requests > before);
  await new Promise((r) => setTimeout(r, 250));
}

describe('Conversation engine — a turn that only changes the order', () => {
  it('ends after one round trip when the reply already said what it was doing', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      {
        text: 'Got it, boneless wings with BBQ. Anything else?',
        tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }],
      },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');

    expect(llm.requests).toBe(1);
    expect(tts.spoken.join(' ')).toContain('Got it, boneless wings with BBQ');
    // The tool's own words are not read out on top of the reply that announced it.
    expect(tts.spoken.join(' ')).not.toMatch(/The order total is now/);
    await engine.stop();
  }, 15_000);

  it('hands the turn back when the reply confirmed but asked nothing', async () => {
    // The reply that ends the turn used to be the one that said "anything
    // else?". On 2026-09-02 18:09 it said "Got it, one large pizza with
    // sausage." and stopped, and ten seconds later the caller said "Hello?".
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      {
        text: 'Got it, one order of boneless wings with BBQ.',
        tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }],
      },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');

    expect(llm.requests).toBe(1); // still one round trip
    expect(tts.spoken.join(' ')).toContain('Anything else?');
    await engine.stop();
  }, 15_000);

  it('does not tack a question onto a reply that already asked one', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      {
        text: 'Got it, boneless wings with BBQ. Anything else for you today?',
        tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }],
      },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');

    expect(tts.spoken.join(' ')).toContain('Anything else for you today?');
    expect(tts.spoken.filter((s) => s.trim() === 'Anything else?')).toHaveLength(0);
    await engine.stop();
  }, 15_000);

  it('still answers when the tool had news the reply could not have known', async () => {
    // The item is not on the menu, so the caller has to be told — the reply
    // that said "got it" was wrong and the second trip is what corrects it.
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      { text: 'Got it, one lobster roll.', tools: [{ name: 'add_item', arguments: { item: 'lobster roll' } }] },
      { text: 'Sorry — we do not have that.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'a lobster roll');

    expect(llm.requests).toBe(2);
    expect(tts.spoken.join(' ')).toContain('Sorry');
    await engine.stop();
  }, 15_000);

  it('still answers a tool that is not an order change', async () => {
    const { engine, stt, llm } = buildEngine();
    llm.script = [
      { text: 'Let me check.', tools: [{ name: 'lookup_hours' }] },
      { text: 'We are open until nine.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'when do you close');

    expect(llm.requests).toBe(2);
    await engine.stop();
  }, 15_000);

  it('still answers a swap the caller did not ask for', async () => {
    // update_item dropping an option to honour a single-select group is news:
    // the model reported a switch that had not happened, once.
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      { text: 'Adding wings.', tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }] },
      { text: 'Switching that.', tools: [{ name: 'update_item', arguments: { item: 'Boneless Wings', modifiers: ['Buffalo (Hot)'] } }] },
      { text: 'Swapped the BBQ for Buffalo Hot.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');
    expect(llm.requests).toBe(1);
    await say(engine, stt, llm, 'make it buffalo hot instead');

    expect(llm.requests).toBe(3); // the swap earned its second trip
    expect(tts.spoken.join(' ')).toContain('Swapped');
    await engine.stop();
  }, 15_000);

  it('says it itself when the reply said nothing and the location wants it quick', async () => {
    // A bare tool call with no words. Asked to announce the change itself the
    // model complies about a third of the time on the real prompt, which is not
    // something a caller can be left waiting on — so the engine says it, from
    // what the tool actually did, and the turn ends there.
    const { engine, stt, llm, tts } = buildEngine('fast');
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }] },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');

    expect(llm.requests).toBe(1);
    expect(tts.spoken.join(' ')).toContain('Got it — Boneless Wings with BBQ. Anything else?');
    await engine.stop();
  }, 15_000);

  it('spends the round trip when the location asked for the AI to word it', async () => {
    const { engine, stt, llm, tts } = buildEngine('natural');
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }] },
      { text: 'Lovely — boneless wings with BBQ it is.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'boneless wings with BBQ');

    expect(llm.requests).toBe(2);
    expect(tts.spoken.join(' ')).toContain('Lovely');
    await engine.stop();
  }, 15_000);

  it('does not say it itself when the tool had news, even in quick mode', async () => {
    // The item is not on the menu: there is no change to announce, and the
    // caller has to be told. That still costs the round trip, in either mode.
    const { engine, stt, llm, tts } = buildEngine('fast');
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'lobster roll' } }] },
      { text: 'Sorry — we do not have that.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'a lobster roll');

    expect(llm.requests).toBe(2);
    expect(tts.spoken.join(' ')).toContain('Sorry');
    await engine.stop();
  }, 15_000);

  it('reads a menu name the way a person would say it', async () => {
    // "Large Pizza (18\")" spoken whole is "large pizza open paren eighteen
    // inch"; the size is already in the words. Option names keep their
    // qualifier, because Buffalo (Hot) is not Buffalo (Mild).
    const menu: MenuItemInfo[] = [
      {
        id: 'mi-lg',
        name: 'Large Pizza (18")',
        category: 'Pizza',
        priceCents: 1900,
        modifierGroups: [
          {
            id: 'g',
            name: 'Toppings',
            selectionType: 'multi',
            modifiers: [{ id: 'm', name: 'Buffalo (Hot)', priceCents: 0 }],
          },
        ],
      },
    ];
    const stt = new FakeStt();
    const llm = new ScriptedLlm();
    const tts = new FakeTts();
    const engine = new ConversationEngine({
      providers: { stt, llm, tts },
      context: { callId: 'call-say', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => menu,
      loadProfile: async () => ({ name: "Mario's", orderAckMode: 'fast' as const }),
    });
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pizza (18")', modifiers: ['Buffalo (Hot)'] } }] },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(engine, stt, llm, 'a large pizza');

    const said = tts.spoken.join(' ');
    expect(said).toContain('Got it — Large Pizza with Buffalo Hot');
    expect(said).not.toMatch(/\(18/);
    await engine.stop();
  }, 15_000);
});
