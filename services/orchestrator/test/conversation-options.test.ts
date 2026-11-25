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
 * Choices the caller never made, and a fulfillment nobody asked for.
 *
 * On the call of 2026-09-11 22:32 the bot was listing the Quesadilla's
 * toppings when the caller cut in with the next item. It added the pizza and
 * never came back: a plain Quesadilla went to the kitchen with the question
 * unfinished. Earlier that hour it had announced "Great, this'll be a pickup
 * order" without asking, and the caller had to correct it into a delivery.
 *
 * Both are the same lesson as the name gate — what the order depends on is
 * enforced by the tool, not requested of the model. A required choice stops
 * the read-back; an optional one is said in it, where the caller hears it.
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
  toolResults: string[] = [];

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.toolResults = opts.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    const step = this.script[this.requests] ?? {};
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
    id: 'mi-ques',
    name: 'Quesadilla',
    category: 'Wraps',
    priceCents: 950,
    // Saratoga's own shape: toppings are offered, never required.
    modifierGroups: [
      {
        id: 'g-ques-top',
        name: 'Toppings',
        selectionType: 'multi',
        required: false,
        maxSelections: 2,
        modifiers: [
          { id: 'q-chicken', name: 'Chicken', priceCents: 200 },
          { id: 'q-bacon', name: 'Bacon', priceCents: 150 },
        ],
      },
    ],
  },
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
        modifiers: [
          { id: 's-bbq', name: 'BBQ', priceCents: 0 },
          { id: 's-hot', name: 'Buffalo (Hot)', priceCents: 0 },
          { id: 's-mild', name: 'Buffalo (Mild)', priceCents: 0 },
          { id: 's-garlic', name: 'Garlic Parmesan', priceCents: 0 },
        ],
      },
    ],
  },
  { id: 'mi-large', name: 'Large Pizza', category: 'Pizza', priceCents: 1900 },
];

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine(profile: Record<string, unknown> = {}) {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const placed: Array<{ lines: OrderLine[]; opts: Record<string, unknown> }> = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-options', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ orderAckMode: 'natural' as const, ...profile }),
    placeOrder: async (_ctx, lines, opts) => {
      placed.push({ lines, opts: opts as Record<string, unknown> });
      return { orderCode: 'ABCDE', totalCents: 1250 };
    },
  });
  const say = async (text: string, requests: number) => {
    stt.onSegment!({ text, isFinal: true });
    await waitFor(() => llm.requests === requests);
  };
  return { engine, stt, llm, placed, say };
}

describe('Conversation engine — choices the caller has not made', () => {
  it('will not read back an item whose required choice is missing', async () => {
    const { engine, stt, llm, say } = buildEngine();
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings' } }] },
      { text: 'Got it, boneless wings.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'What sauce would you like?' },
      { tools: [{ name: 'update_item', arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] } }] },
      { text: 'BBQ it is.' },
      { tools: [{ name: 'review_order' }] },
      { text: 'Should I go ahead and place the order under Jim?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('boneless wings please', 2);
    await say("that's it, under Jim", 4);
    // Refused, and told what to ask and how to fix it.
    expect(llm.toolResults.at(-1)).toMatch(/needs a choice from Sauce/);
    expect(llm.toolResults.at(-1)).toMatch(/BBQ/);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);

    await say('BBQ', 6);
    await say('yes', 8);
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    expect(readBack).toContain('Boneless Wings');
    expect(readBack).toContain('BBQ');
    await engine.stop();
  }, 15_000);

  it('says in the read-back when an optional question went unanswered', async () => {
    const { engine, stt, llm, say } = buildEngine();
    llm.script = [
      // The shape of the real call: the toppings question is cut off by the
      // next item, and never comes back.
      { tools: [{ name: 'add_item', arguments: { item: 'Quesadilla' } }] },
      { text: 'You can pick up to two toppings — chicken, bacon…' },
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pizza' } }] },
      { text: 'Got it, a large pizza.' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'Should I go ahead and place the order under Jim?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('a quesadilla', 2);
    await say('and then one large pizza', 4);
    await say("that's it, under Jim", 6);

    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    // The caller hears what was never answered, and can still change it.
    expect(readBack).toContain('1 Quesadilla (no Toppings chosen)');
    // The pizza has no groups at all, so it says nothing about options.
    expect(readBack).toContain('1 Large Pizza');
    expect(readBack).not.toMatch(/Large Pizza \(no/);
    await engine.stop();
  }, 15_000);

  it("will not take pickup or delivery on the model's say-so", async () => {
    const both = { pickupEnabled: true, deliveryEnabled: true, pickupEtaMinutes: 20, deliveryEtaMinutes: 45 };
    const { engine, stt, llm, placed, say } = buildEngine(both);
    llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pizza' } }] },
      { text: 'Got it, a large pizza.' },
      // The 22:21 call: announced, never asked.
      {
        tools: [
          { name: 'set_fulfillment', arguments: { type: 'pickup' } },
          { name: 'review_order', arguments: { customer_name: 'Jim' } },
        ],
      },
      { text: 'Is this for pickup or delivery?' },
      { tools: [{ name: 'set_fulfillment', arguments: { type: 'pickup' } }, { name: 'review_order' }] },
      { text: 'Should I go ahead and place the order for pickup under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pizza', 2);
    await say("that's everything, under Jim", 4);
    expect(llm.toolResults.some((r) => /must not be assumed/.test(r))).toBe(true);
    // And the read-back is still held: nobody has said which it is.
    expect(llm.toolResults.at(-1)).toMatch(/Is this for pickup or delivery\?/);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);

    // Asked, and answered by the caller — now it is theirs to give.
    await say('Pickup.', 6);
    expect(llm.toolResults.some((r) => /^Pickup —/.test(r))).toBe(true);
    await say('yes', 8);
    expect(placed[0]!.opts.fulfillmentType).toBe('pickup');
    await engine.stop();
  }, 15_000);

  it('takes the caller at their word when they said it themselves', async () => {
    const both = { pickupEnabled: true, deliveryEnabled: true, pickupEtaMinutes: 20, deliveryEtaMinutes: 45 };
    const { engine, stt, llm, say } = buildEngine(both);
    llm.script = [
      {
        tools: [
          { name: 'add_item', arguments: { item: 'Large Pizza' } },
          { name: 'set_fulfillment', arguments: { type: 'pickup' } },
        ],
      },
      { text: 'Got it — pickup.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say("one large pizza, I'll pick it up", 2);
    expect(llm.toolResults.some((r) => /must not be assumed/.test(r))).toBe(false);
    expect(llm.toolResults.some((r) => /^Pickup —/.test(r))).toBe(true);
    await engine.stop();
  }, 15_000);
});
