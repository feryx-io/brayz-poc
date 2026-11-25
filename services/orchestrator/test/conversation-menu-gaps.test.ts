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
 * Noticing what the menu could not sell.
 *
 * The engine is the only place that knows a request went unmatched: it works it
 * out, tells the caller "we don't have that", and used to forget. Ten people a
 * week asking for ketchup is the one piece of evidence a restaurant gets that
 * it might want to sell ketchup.
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
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
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
    const step = this.script[this.requests] ?? { text: 'Okay.' };
    this.requests += 1;
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
    category: 'Starters',
    priceCents: 1250,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: [{ id: 'm-bbq', name: 'BBQ', priceCents: 0 }],
      },
    ],
  },
];

type Gap = { kind: string; term: string; onItem?: string };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine(reportMenuGap?: (ctx: unknown, gap: Gap) => void) {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-gap', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    ...(reportMenuGap ? { reportMenuGap: reportMenuGap as never } : {}),
  });
  return { engine, stt, llm };
}

async function say(stt: FakeStt, llm: ScriptedLlm, text: string): Promise<void> {
  const before = llm.requests;
  stt.onSegment!({ text, isFinal: true });
  await waitFor(() => llm.requests > before);
  await new Promise((r) => setTimeout(r, 150));
}

describe('Conversation engine — what the menu could not sell', () => {
  it('reports an item it had to turn down', async () => {
    const gaps: Gap[] = [];
    const { engine, stt, llm } = buildEngine((_c, g) => gaps.push(g));
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'ketchup' } }] },
      { text: "Sorry, we don't have that." },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await say(stt, llm, 'can I get some ketchup');

    expect(gaps).toEqual([{ kind: 'item', term: 'ketchup' }]);
    await engine.stop();
  }, 15_000);

  it('reports an option the item does not have, and says which item', async () => {
    // The ranch case: the kitchen will make it, the menu cannot price it.
    const gaps: Gap[] = [];
    const { engine, stt, llm } = buildEngine((_c, g) => gaps.push(g));
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ', 'ranch'] } }] },
      { text: 'Added.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await say(stt, llm, 'wings with bbq and ranch');

    expect(gaps).toEqual([{ kind: 'option', term: 'ranch', onItem: 'Boneless Wings' }]);
    await engine.stop();
  }, 15_000);

  it('says nothing about an item it could sell', async () => {
    const gaps: Gap[] = [];
    const { engine, stt, llm } = buildEngine((_c, g) => gaps.push(g));
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }] },
      { text: 'Added.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await say(stt, llm, 'wings with bbq');

    expect(gaps).toEqual([]);
    await engine.stop();
  }, 15_000);

  it('answers the caller the same way whether the reporter works, is absent, or throws', async () => {
    // A dashboard statistic must never change what the caller is told. A
    // synchronous throw here would otherwise be caught upstream and turn "that
    // is not on the menu" into "that could not be completed right now".
    const results: string[] = [];
    for (const reporter of [undefined, () => {}, () => { throw new Error('API down'); }]) {
      const stt = new FakeStt();
      const llm = new ScriptedLlm();
      const seen: string[] = [];
      const engine = new ConversationEngine({
        providers: { stt, llm, tts: new FakeTts() },
        context: { callId: 'call-gap', sampleRate: 8000, restaurantName: "Jimmy's" },
        io: { sendAudio: () => {}, send: () => {} },
        log: pino({ level: 'silent' }),
        loadMenu: async () => MENU,
        loadProfile: async () => ({ orderAckMode: 'natural' as const }),
        ...(reporter ? { reportMenuGap: reporter as never } : {}),
      });
      llm.script = [
        { tools: [{ name: 'add_item', arguments: { item: 'ketchup' } }] },
        { text: 'relaying' },
      ];
      const original = llm.stream.bind(llm);
      llm.stream = async (opts) => {
        for (const m of opts.messages) if (m.role === 'tool') seen.push(m.content);
        return original(opts);
      };
      await engine.start();
      await waitFor(() => stt.onSegment !== undefined);
      await say(stt, llm, 'can I get some ketchup');
      expect(llm.requests).toBe(2);
      results.push(seen.at(-1) ?? '');
      await engine.stop();
    }
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).toMatch(/not on the menu/);
  }, 15_000);
});
