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
import {
  ConversationEngine,
  type GuestInfo,
  type MenuItemInfo,
  type OrderLine,
} from '../src/conversation.js';

/**
 * Every order goes under a name.
 *
 * On the call of 2026-09-04 16:48 a first-time caller's order was read back,
 * confirmed and placed with no name at all — the prompt said to ask, the
 * model did not, and the ticket had a blank where the name goes. The gate is
 * in the tools now: review_order will not read back a nameless order and
 * place_order will not place one. A recognized guest is never asked; the
 * read-back confirms their name instead.
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
  /** Every system message the engine has sent, so the guest context can be checked. */
  systemMessages: string[] = [];

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.toolResults = opts.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    this.systemMessages = opts.messages.filter((m) => m.role === 'system').map((m) => m.content);
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

function buildEngine(guest?: GuestInfo) {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const tts = new FakeTts();
  const placed: Array<{ lines: OrderLine[]; customerName?: string }> = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-name', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    loadGuest: guest ? async () => guest : undefined,
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

describe('Conversation engine — the name an order goes under', () => {
  it('will not read back a nameless order from a caller it does not know', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      // The shape of the 2026-09-04 call: done adding, straight to the read-back.
      { tools: [{ name: 'review_order' }] },
      { text: 'And what name should I put the order under?' },
      // The caller answers; now the read-back goes through, with the name.
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'One large pepperoni, eighteen dollars. Should I go ahead and place the order under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set, Jim.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);

    // Refused, and told exactly what to do about it.
    expect(llm.toolResults.some((r) => /no name on the order/i.test(r))).toBe(true);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);

    stt.onSegment!({ text: 'Jim', isFinal: true });
    await waitFor(() => llm.requests === 6);
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r));
    expect(readBack).toContain('Under the name Jim');
    expect(readBack).toContain('Should I go ahead and place the order under Jim?');
    expect(placed).toHaveLength(0);

    stt.onSegment!({ text: 'yes', isFinal: true });
    await waitFor(() => placed.length === 1);
    // place_order carried no name of its own; the one review_order took is used.
    expect(placed[0]!.customerName).toBe('Jim');
    await engine.stop();
  }, 15_000);

  it('will not place a nameless order either, even if the model skips the read-back', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'place_order' }] },
      { text: 'What name should I put that under?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: 'just place it', isFinal: true });
    await waitFor(() => llm.requests === 4);

    expect(placed).toHaveLength(0);
    // The name comes before the confirmation gate: the model is told the first
    // thing it is missing, not the second.
    const refusal = llm.toolResults.find((r) => /Not yet|Not placed/.test(r));
    expect(refusal).toMatch(/no name on the order/i);
    expect(refusal).not.toMatch(/has not been read back/i);
    await engine.stop();
  }, 15_000);

  it('never asks a recognized guest: the read-back confirms their name instead', async () => {
    const { engine, stt, llm, placed } = buildEngine({
      isReturning: true,
      displayName: 'Mike',
      mode: 'full',
    });
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order' }] },
      { text: 'One large pepperoni, eighteen dollars. Should I go ahead and place the order under Mike?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set, Mike.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    // The guest context tells the model the name is already on the order.
    expect(llm.systemMessages.join('\n')).toMatch(/order goes under it automatically/);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);

    const readBack = llm.toolResults.find((r) => /Current order:/.test(r));
    expect(readBack).toContain('Should I go ahead and place the order under Mike?');
    expect(llm.toolResults.some((r) => /no name on the order/i.test(r))).toBe(false);

    stt.onSegment!({ text: 'yes', isFinal: true });
    await waitFor(() => placed.length === 1);
    expect(placed[0]!.customerName).toBe('Mike');
    await engine.stop();
  }, 15_000);

  it('in confirm-first mode the name has to come from the caller, not the phone match', async () => {
    // Rule #6: the number matched a guest, but nobody has confirmed the person
    // on the line is that guest. Their answer to "what name?" is the check.
    const { engine, stt, llm, placed } = buildEngine({
      isReturning: true,
      displayName: 'Mike',
      mode: 'confirm',
    });
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order' }] },
      { text: 'Can I get a name for the order?' },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Mike' } }] },
      { text: 'Should I go ahead and place the order under Mike?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);
    expect(llm.toolResults.some((r) => /no name on the order/i.test(r))).toBe(true);

    stt.onSegment!({ text: 'Mike', isFinal: true });
    await waitFor(() => llm.requests === 6);
    stt.onSegment!({ text: 'yes', isFinal: true });
    await waitFor(() => placed.length === 1);
    expect(placed[0]!.customerName).toBe('Mike');
    await engine.stop();
  }, 15_000);

  it('a second order in the same call stays under the same name', async () => {
    const { engine, stt, llm, placed } = buildEngine();
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'Should I go ahead and place the order under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pepperoni' } }] },
      { text: 'Added another.' },
      { tools: [{ name: 'review_order' }] },
      { text: 'Should I go ahead and place the order under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'Done.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: "that's all", isFinal: true });
    await waitFor(() => llm.requests === 4);
    stt.onSegment!({ text: 'yes', isFinal: true });
    await waitFor(() => placed.length === 1);

    stt.onSegment!({ text: 'oh, one more pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 8);
    stt.onSegment!({ text: "that's it", isFinal: true });
    await waitFor(() => llm.requests === 10);
    // The second read-back went through without asking again.
    expect(llm.toolResults.filter((r) => /Under the name Jim/.test(r))).toHaveLength(2);
    stt.onSegment!({ text: 'yes', isFinal: true });
    await waitFor(() => placed.length === 2);
    expect(placed[1]!.customerName).toBe('Jim');
    await engine.stop();
  }, 15_000);
});
