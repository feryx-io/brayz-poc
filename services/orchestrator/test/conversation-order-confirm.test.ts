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
 * The gate between reading an order back and placing it.
 *
 * Replaying the call of 2026-09-02 through the live model, the read-back and
 * the place_order acting on it came back in one assistant message — "shall I
 * go ahead and place it?" and the placing, with no gap for the caller to say
 * no. These drive that exact shape through the engine.
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

/** Says exactly what the script says, one entry per request the engine makes. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'fake-llm';
  script: Step[] = [];
  requests = 0;
  /** Every tool result the engine has handed back, in order. */
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

const MENU: MenuItemInfo[] = [{ id: 'mi-1', name: 'Large Pepperoni', priceCents: 1800 }];

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
  const tts = new FakeTts();
  const placed: Array<{ lines: OrderLine[]; customerName?: string }> = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-confirm', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    // Asserts on what the tool says back to the model, which only reaches the
    // caller when the location has asked the AI to word confirmations.
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    placeOrder: async (_ctx, lines, opts) => {
      placed.push({ lines, customerName: opts.customerName });
      return { orderCode: 'ABCDE', totalCents: 1800 };
    },
  });
  return { engine, stt, llm, tts, placed };
}

/** The steps that get one pepperoni onto the order. */
const ADD: Step[] = [
  { tools: [{ name: 'add_item', arguments: { item: 'Large Pepperoni' } }] },
  { text: 'Added a large pepperoni.' },
];

describe('Conversation engine — placing an order the caller has not answered', () => {
  it('refuses a place_order that arrives in the same reply as the read-back', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      // The shape the live model produced: the question and the act of placing,
      // in one breath.
      {
        text: "That's one large pepperoni, eighteen dollars. Shall I place it?",
        tools: [{ name: 'place_order', arguments: { customer_name: 'Sam' } }],
      },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);

    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);
    await new Promise((r) => setTimeout(r, 150));

    // Nothing was placed, and the model was told what is missing.
    expect(placed).toHaveLength(0);
    llm.script[4] = { tools: [{ name: 'place_order', arguments: { customer_name: 'Sam' } }] };

    // The read-back still reached the caller — the gate stops the placing, not
    // the question.
    stt.onSegment!({ text: 'yes please', isFinal: true });
    await waitFor(() => placed.length === 1);
    expect(llm.toolResults.some((r) => /has not answered it yet/i.test(r))).toBe(true);
    expect(placed[0]!.customerName).toBe('Sam');
    expect(placed[0]!.lines).toMatchObject([{ name: 'Large Pepperoni', quantity: 1 }]);
    await engine.stop();
  }, 15_000);

  it('refuses a place_order when the order was never read back at all', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'place_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Let me read that back to you first.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);

    stt.onSegment!({ text: 'just place it', isFinal: true });
    await waitFor(() => llm.requests === 4);

    expect(placed).toHaveLength(0);
    expect(llm.toolResults.some((r) => /has not been read back yet/i.test(r))).toBe(true);
    await engine.stop();
  }, 15_000);

  it('places it on the turn after the read-back, which is the normal path', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: "One large pepperoni, eighteen dollars. Shall I place it?" },
      { tools: [{ name: 'place_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'All set, Sam.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);
    expect(placed).toHaveLength(0);

    stt.onSegment!({ text: 'yes go ahead', isFinal: true });
    await waitFor(() => placed.length === 1);
    expect(llm.toolResults.some((r) => /Confirmation code A B C D E/.test(r))).toBe(true);
    await engine.stop();
  }, 15_000);

  it('makes a second order in the same call earn its own read-back', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      { text: 'Shall I place it?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
      // A second order: added, then placed straight off the first one's confirmation.
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pepperoni' } }] },
      { text: 'Added another.' },
      { tools: [{ name: 'place_order' }] },
      { text: 'Let me read that back.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);
    stt.onSegment!({ text: 'yes go ahead', isFinal: true });
    await waitFor(() => placed.length === 1);

    stt.onSegment!({ text: 'actually add another one', isFinal: true });
    await waitFor(() => llm.requests === 8);
    stt.onSegment!({ text: 'place that too', isFinal: true });
    await waitFor(() => llm.requests === 10);

    // The first order's read-back does not carry over to the second.
    expect(placed).toHaveLength(1);
    expect(llm.toolResults.some((r) => /has not been read back yet/i.test(r))).toBe(true);
    await engine.stop();
  }, 15_000);
});

describe('Conversation engine — the turn that read the order back', () => {
  it('ends without a second pass rather than asking again', async () => {
    // Handed the refusal and asked to explain itself, the live model apologizes
    // and re-asks a question the caller has already heard. The read-back is
    // said, so the turn is over; their answer is the next thing that happens.
    const { engine, stt, llm, tts, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }] },
      {
        text: 'One large pepperoni, eighteen dollars. Shall I place it?',
        tools: [{ name: 'place_order' }],
      },
      // Never reached: the turn ends on the refusal.
      { text: 'Sorry about that — shall I place it?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Shall I place it/.test(s)));
    await new Promise((r) => setTimeout(r, 150));

    expect(placed).toHaveLength(0);
    expect(llm.requests).toBe(4); // add, relay, review, read-back — no fifth pass
    expect(tts.spoken.some((s) => /Sorry about that/.test(s))).toBe(false);
    await engine.stop();
  }, 15_000);

  it('still speaks the read-back when the turn had not said anything yet', async () => {
    // The other shape: place_order with no words alongside it. Ending the turn
    // there would leave the caller in silence, so the loop runs on.
    const { engine, stt, llm, tts, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Sam' } }, { name: 'place_order' }] },
      { text: 'One large pepperoni, eighteen dollars. Shall I place it?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Shall I place it/.test(s)));

    expect(placed).toHaveLength(0);
    await engine.stop();
  }, 15_000);
});
