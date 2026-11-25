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
import { ConversationEngine, type MenuItemInfo, type OrderLine } from '../src/conversation.js';

/**
 * A second helping is not a free one.
 *
 * Wings come with a dip: the menu carries Ranch and Blue Cheese as $0 options
 * on the item, and a paid Ranch side of its own. A caller who has ranch and
 * asks for another can be understood two ways, and only one of them charges.
 * Through update_item the single-select rule replaces Ranch with Ranch — no
 * change, no money, and a tool result claiming it both added and removed it.
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
  results: string[] = [];
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.results = opts.messages.filter((m) => m.role === 'tool').map((m) => m.content);
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

const DIP = {
  id: 'g-dip',
  name: 'Dip (included)',
  selectionType: 'single' as const,
  required: true,
  modifiers: [
    { id: 'm-ranch', name: 'Ranch', priceCents: 0 },
    { id: 'm-blue', name: 'Blue Cheese', priceCents: 0 },
  ],
};

const MENU: MenuItemInfo[] = [
  { id: 'mi-wings', name: 'Boneless Wings', category: 'Starters', priceCents: 1250, modifierGroups: [DIP] },
  { id: 'mi-ranch', name: 'Ranch', category: 'Sides', priceCents: 100 },
];

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine() {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const placed: OrderLine[][] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-extra', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    placeOrder: async (_ctx, lines) => {
      placed.push(lines);
      return { orderCode: 'ABCDE', totalCents: 0 };
    },
  });
  return { engine, stt, llm, placed };
}

async function say(stt: FakeStt, llm: ScriptedLlm, text: string): Promise<void> {
  const before = llm.requests;
  stt.onSegment!({ text, isFinal: true });
  await waitFor(() => llm.requests > before);
  await new Promise((r) => setTimeout(r, 200));
}

describe('Conversation engine — asking for the dip it already has', () => {
  it('turns the update down and points at the tool that can charge for it', async () => {
    const { engine, stt, llm } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Got it, wings with ranch.' },
      { tools: [{ name: 'update_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Adding a side of ranch.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(stt, llm, 'boneless wings with ranch');
    await say(stt, llm, 'can I get another ranch');

    const turned = llm.results.find((r) => /already has Ranch/.test(r));
    expect(turned).toBeDefined();
    expect(turned).toMatch(/add_item/);
    await engine.stop();
  }, 15_000);

  it('leaves the line exactly as it was', async () => {
    // The old path replaced Ranch with Ranch: one option in, one out, and a
    // reply that said so. Nothing should move.
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Got it.' },
      { tools: [{ name: 'update_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'One moment.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Shall I place it?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(stt, llm, 'boneless wings with ranch');
    await say(stt, llm, 'another ranch');
    await say(stt, llm, "that's it");
    await say(stt, llm, 'yes');

    await waitFor(() => placed.length === 1);
    expect(placed[0]).toHaveLength(1);
    expect(placed[0]![0]!.modifiers?.map((m) => m.name)).toEqual(['Ranch']);
    await engine.stop();
  }, 15_000);

  it('still charges for the extra when it is added as its own item', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Got it.' },
      { tools: [{ name: 'add_item', arguments: { item: 'Ranch' } }] },
      { text: 'Added a side of ranch.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Shall I place it?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(stt, llm, 'boneless wings with ranch');
    await say(stt, llm, 'and a side of ranch too');
    await say(stt, llm, "that's it");
    await say(stt, llm, 'yes');

    await waitFor(() => placed.length === 1);
    const lines = placed[0]!;
    expect(lines.map((l) => l.name)).toEqual(['Boneless Wings', 'Ranch']);
    expect(lines[1]!.unitPriceCents).toBe(100); // the side is not free
    await engine.stop();
  }, 15_000);

  it('still swaps to a different option', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Got it.' },
      { tools: [{ name: 'update_item', arguments: { item: 'Boneless Wings', modifiers: ['Blue Cheese'] } }] },
      { text: 'Swapped it.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Shall I place it?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(stt, llm, 'boneless wings with ranch');
    await say(stt, llm, 'make it blue cheese instead');
    await say(stt, llm, "that's it");
    await say(stt, llm, 'yes');

    await waitFor(() => placed.length === 1);
    expect(placed[0]![0]!.modifiers?.map((m) => m.name)).toEqual(['Blue Cheese']);
    await engine.stop();
  }, 15_000);

  it('still records a request that came alongside the repeated option', async () => {
    // "ranch, and no celery" is a real change carrying a redundancy.
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Ranch'] } }] },
      { text: 'Got it.' },
      {
        tools: [
          {
            name: 'update_item',
            arguments: { item: 'Boneless Wings', modifiers: ['Ranch'], special_instructions: 'no celery' },
          },
        ],
      },
      { text: 'Noted.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Shall I place it?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say(stt, llm, 'boneless wings with ranch');
    await say(stt, llm, 'no celery please');
    await say(stt, llm, "that's it");
    await say(stt, llm, 'yes');

    await waitFor(() => placed.length === 1);
    expect(placed[0]![0]!.specialInstructions).toContain('no celery');
    await engine.stop();
  }, 15_000);
});
