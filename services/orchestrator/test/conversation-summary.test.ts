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
import { ConversationEngine } from '../src/conversation.js';

/**
 * Call summaries. The restaurant reads these on the Calls screen to decide
 * whether a call needs anything from them, so the thing that matters most is
 * that a summary is never invented and never holds the call record open.
 */
class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}

class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  reply = 'Sure, one large cheese pizza.';
  summary = 'Caller ordered a large cheese pizza for pickup. Nothing outstanding.';
  /** Messages the summarization call was given, for asserting on what it saw. */
  summaryMessages: LlmMessage[] | null = null;
  calls = 0;
  /** Set to make the summarize round-trip hang, so the timeout is exercised. */
  hangOnSummary = false;
  /** Set to make the summarize round-trip throw. */
  failOnSummary = false;
  /** Set to make the first turn call a tool, so the history holds tool plumbing. */
  callToolFirst = false;

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    this.calls += 1;
    const last = opts.messages[opts.messages.length - 1];
    const isSummary = last?.content.includes('Write a summary');
    if (!isSummary) {
      if (this.callToolFirst && !opts.messages.some((m) => m.role === 'tool')) {
        opts.onEvent({
          type: 'tool_call',
          toolCall: { id: 't1', name: 'lookup_hours', arguments: {} },
        });
        opts.onEvent({ type: 'done' });
        return;
      }
      opts.onEvent({ type: 'text', textDelta: this.reply });
      opts.onEvent({ type: 'done' });
      return;
    }

    this.summaryMessages = opts.messages;
    if (this.failOnSummary) throw new Error('anthropic 500');
    if (this.hangOnSummary) {
      // Resolve only when the engine's own timeout aborts us.
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve());
      });
      return;
    }
    opts.onEvent({ type: 'text', textDelta: this.summary });
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    opts.onAudio(new Uint8Array(320));
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine() {
  const stt = new FakeStt();
  const llm = new FakeLlm();
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-sum', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    toolExecutor: async () => 'Monday: 11 AM to 9 PM.',
  });
  return { engine, stt, llm };
}

describe('Conversation engine — call summary', () => {
  it('summarizes what was actually said', async () => {
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'I want a large cheese pizza', isFinal: true });
    await waitFor(() => llm.calls >= 1);
    await new Promise((r) => setTimeout(r, 50));

    const summary = await engine.summarize();
    expect(summary).toBe('Caller ordered a large cheese pizza for pickup. Nothing outstanding.');

    // The model is shown the conversation and then asked to summarize it — the
    // receptionist system prompt is left out so it summarizes rather than replies.
    const seen = llm.summaryMessages!;
    expect(seen.some((m) => m.role === 'system')).toBe(false);
    expect(seen.some((m) => m.content.includes('I want a large cheese pizza'))).toBe(true);
    expect(seen[seen.length - 1].content).toContain('Write a summary');
    await engine.stop();
  });

  it('leaves the tool plumbing out of the summary request', async () => {
    const { engine, stt, llm } = buildEngine();
    llm.callToolFirst = true;
    llm.reply = 'We close at nine tonight.';
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'what time do you close', isFinal: true });
    await waitFor(() => llm.calls >= 2);
    await new Promise((r) => setTimeout(r, 50));

    expect(await engine.summarize()).toBe(llm.summary);

    // The live history pairs an assistant tool call with a `tool` result
    // message, and a turn the caller barges is aborted between the two — a
    // dangling tool call a real provider rejects outright. The summary is given
    // the words instead, so neither shape can reach it.
    const seen = llm.summaryMessages!;
    expect(seen.every((m) => m.role === 'user')).toBe(true);
    expect(seen.some((m) => m.toolCalls?.length)).toBe(false);
    expect(seen[0].content).toContain('Caller: what time do you close');
    expect(seen[0].content).toContain('Receptionist: We close at nine tonight.');
    await engine.stop();
  });

  it('returns null for a call where the caller never said anything', async () => {
    const { engine, llm } = buildEngine();
    await engine.start(); // greeting only — the caller hung up
    await new Promise((r) => setTimeout(r, 30));
    const before = llm.calls;

    // No summary, and no LLM round-trip spent finding that out.
    expect(await engine.summarize()).toBeNull();
    expect(llm.calls).toBe(before);
    await engine.stop();
  });

  it('gives up rather than holding the call record open', async () => {
    const { engine, stt, llm } = buildEngine();
    llm.hangOnSummary = true;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'do you deliver', isFinal: true });
    await waitFor(() => llm.calls >= 1);
    await new Promise((r) => setTimeout(r, 50));

    // The engine aborts its own request after SUMMARY_TIMEOUT_MS (10 s). This
    // asserts the abort is wired at all — without it the promise never settles.
    const summary = await engine.summarize();
    expect(summary).toBeNull();
    await engine.stop();
  }, 20_000);

  it('swallows a provider failure — a missing summary is not a failed call', async () => {
    const { engine, stt, llm } = buildEngine();
    llm.failOnSummary = true;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'are you open on sunday', isFinal: true });
    await waitFor(() => llm.calls >= 1);
    await new Promise((r) => setTimeout(r, 50));

    await expect(engine.summarize()).resolves.toBeNull();
    await engine.stop();
  });
});

/**
 * The summary is written from what the call did, not only from what was said.
 * On the call of 2026-09-14 19:17 the bot read back "your updated order…
 * Should I save that change?", the API refused it (the kitchen had accepted),
 * and the summary said "The system confirmed the update and a new total of
 * $25.25". The engine now hands the summary a record of each outcome.
 */
describe('Conversation engine — summary from the call record', () => {
  class ScriptLlm implements LlmProvider {
    readonly name = 'fake-llm';
    summaryPrompt = '';
    private step = 0;
    async stream(opts: { messages: LlmMessage[]; onEvent: (e: LlmStreamEvent) => void }): Promise<void> {
      const last = opts.messages[opts.messages.length - 1]!;
      if (last.content.includes('Write a summary')) {
        this.summaryPrompt = last.content;
        opts.onEvent({ type: 'text', textDelta: 'Summary.' });
        opts.onEvent({ type: 'done' });
        return;
      }
      if (last.role === 'tool') {
        opts.onEvent({ type: 'text', textDelta: 'OK.' });
        opts.onEvent({ type: 'done' });
        return;
      }
      const script: Array<Array<{ name: string; arguments: Record<string, unknown> }>> = [
        [{ name: 'lookup_recent_order', arguments: {} }],
        [
          { name: 'change_order', arguments: {} },
          { name: 'add_item', arguments: { item: 'Knots' } },
          { name: 'review_order', arguments: {} },
        ],
        [{ name: 'place_order', arguments: {} }],
      ];
      const calls = script[this.step++] ?? [];
      calls.forEach((c, i) => opts.onEvent({ type: 'tool_call', toolCall: { id: `s${this.step}-${i}`, ...c } }));
      if (!calls.length) opts.onEvent({ type: 'text', textDelta: 'OK.' });
      opts.onEvent({ type: 'done' });
    }
  }

  async function changeRefusedCall() {
    const stt = new FakeStt();
    const llm = new ScriptLlm();
    const states: string[] = [];
    const engine = new ConversationEngine({
      providers: { stt, llm, tts: new FakeTts() },
      context: { callId: 'call-record', sampleRate: 8000, restaurantName: "Jimmy's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => [
        { id: 'mi-pizza', name: 'Large Pizza (18")', priceCents: 1900 },
        { id: 'mi-knots', name: 'Knots', priceCents: 625 },
      ],
      loadRecentOrder: async () => ({
        found: true as const,
        needsCode: false as const,
        orderId: 'o-1',
        orderCode: '89A13',
        placedAt: '2026-09-14T19:17:16Z',
        fulfillmentType: 'pickup',
        scheduledFor: null,
        customerName: 'James',
        subtotalCents: 1900,
        deliveryFeeCents: 0,
        totalCents: 1900,
        items: [
          { menuItemId: 'mi-pizza', name: 'Large Pizza (18")', quantity: 1, unitPriceCents: 1900, specialInstructions: null, modifiers: [] },
        ],
        posTicket: false,
      }),
      changeOrder: async () => ({ ok: false as const, code: 'order_locked', message: 'The order is already accepted' }),
      onStateChange: (st) => states.push(st),
    });
    await engine.start();
    const settle = async (text: string) => {
      const mark = states.length;
      stt.onSegment!({ text, isFinal: true });
      const start = Date.now();
      while (!(states.slice(mark).includes('thinking') && states.at(-1) === 'listening')) {
        if (Date.now() - start > 4000) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 5));
      }
    };
    while (!states.includes('listening')) await new Promise((r) => setTimeout(r, 5));
    await settle("I'd like to add garlic knots to my last order.");
    await settle('Correct.');
    await settle('Yes, go ahead and save.');
    const summary = await engine.summarize();
    await engine.stop();
    return { llm, summary };
  }

  it('tells the summary a refused change was refused, with nothing saved', async () => {
    const { llm } = await changeRefusedCall();
    expect(llm.summaryPrompt).toContain('The change was REFUSED because the kitchen had already accepted the order');
    expect(llm.summaryPrompt).toContain('order #89A13');
    expect(llm.summaryPrompt).toMatch(/is\s+not a confirmation/);
    expect(llm.summaryPrompt).not.toContain('No order was placed, changed or canceled');
  });

  it('says so when the call did nothing', async () => {
    const llm = new FakeLlm();
    const stt = new FakeStt();
    const engine = new ConversationEngine({
      providers: { stt, llm, tts: new FakeTts() },
      context: { callId: 'call-nothing', sampleRate: 8000 },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
    });
    await engine.start();
    while (!stt.onSegment) await new Promise((r) => setTimeout(r, 5));
    stt.onSegment({ text: 'What time do you close?', isFinal: true });
    while (llm.calls < 1) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 300));
    await engine.summarize();
    await engine.stop();
    const prompt = llm.summaryMessages?.at(-1)?.content ?? '';
    expect(prompt).toContain('No order was placed, changed or canceled, no message was taken');
  });
});
