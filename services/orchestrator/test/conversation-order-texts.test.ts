import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  LlmToolCall,
  LlmToolDefinition,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { guestOrderTextsOffer } from '@brayz/shared';
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * A text when the order is ready (rule #6). The engine asks, after the order
 * is placed and its code read, in fixed words that carry the disclosure; the
 * model only reports the caller's answer, through a tool that does not exist
 * until the question has been asked and the caller has spoken since.
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

/** Plays one scripted tool call per caller turn, relays each tool's words, and records what tools it was given. */
class ScriptLlm implements LlmProvider {
  readonly name = 'fake-llm';
  toolsByTurn: string[][] = [];
  constructor(private readonly script: Array<LlmToolCall[]>) {}
  async stream(opts: { messages: LlmMessage[]; tools?: LlmToolDefinition[]; onEvent: (e: LlmStreamEvent) => void }) {
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'tool') {
      opts.onEvent({ type: 'text', textDelta: last.content });
      opts.onEvent({ type: 'done' });
      return;
    }
    this.toolsByTurn.push((opts.tools ?? []).map((t) => t.name));
    const calls = this.script.shift() ?? [];
    for (const c of calls) opts.onEvent({ type: 'tool_call', toolCall: c });
    if (!calls.length) opts.onEvent({ type: 'text', textDelta: 'Okay.' });
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [{ id: 'mi-1', name: 'Large Pizza', priceCents: 1900 }];

async function waitFor(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function call(script: Array<LlmToolCall[]>, lines: string[], opts: { offer?: boolean } = {}) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const llm = new ScriptLlm(script);
  const states: string[] = [];
  const consents: Array<{ orderCode: string; callerWords?: string }> = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-texts', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({
      name: "Jimmy's",
      orderAckMode: 'natural' as const,
      guestOrderTexts: { offer: opts.offer ?? true },
    }),
    placeOrder: async () => ({ orderCode: 'AB12C', totalCents: 1900, etaMinutes: 20 }),
    recordOrderTextConsent: async (_ctx, consent) => {
      consents.push(consent);
      return true;
    },
    onStateChange: (s) => states.push(s),
  });
  await engine.start();
  await waitFor(() => states.includes('listening'));
  for (const text of lines) {
    const mark = states.length;
    stt.onSegment!({ text, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'));
    await waitFor(() => states.slice(mark).at(-1) === 'listening');
  }
  await engine.stop();
  return { spoken: tts.spoken.join(' '), toolsByTurn: llm.toolsByTurn, consents };
}

const ORDER: Array<LlmToolCall[]> = [
  [
    { id: 'a', name: 'add_item', arguments: { item: 'Large Pizza' } },
    { id: 'r', name: 'review_order', arguments: { customer_name: 'Sam' } },
  ],
  [{ id: 'p', name: 'place_order', arguments: { customer_name: 'Sam' } }],
];

describe('Conversation engine — a text when the order is ready', () => {
  it('asks in fixed words after the order is placed, and records a yes with the caller’s words', async () => {
    const { spoken, toolsByTurn, consents } = await call(
      [...ORDER, [{ id: 't', name: 'order_text_updates', arguments: { agreed: true } }]],
      ['A large pizza, under Sam.', 'Yes, place it.', 'Yeah, sure.'],
    );
    expect(spoken).toContain(guestOrderTextsOffer("Jimmy's"));
    // The offer comes after the confirmation code.
    expect(spoken.indexOf('A B 1 2 C')).toBeLessThan(spoken.indexOf('Would you like a text'));
    // No tool to record a yes until the question has been asked.
    expect(toolsByTurn[0]).not.toContain('order_text_updates');
    expect(toolsByTurn[1]).not.toContain('order_text_updates');
    expect(toolsByTurn[2]).toContain('order_text_updates');
    expect(consents).toEqual([{ orderCode: 'AB12C', callerWords: 'Yeah, sure.' }]);
  });

  it('records nothing for a no', async () => {
    const { consents, spoken } = await call(
      [...ORDER, [{ id: 't', name: 'order_text_updates', arguments: { agreed: false } }]],
      ['A large pizza, under Sam.', 'Yes, place it.', 'No thanks.'],
    );
    expect(spoken).toContain('Would you like a text');
    expect(consents).toEqual([]);
  });

  it('does not ask when the restaurant does not text guests', async () => {
    const { spoken, toolsByTurn } = await call(ORDER, ['A large pizza, under Sam.', 'Yes, place it.'], { offer: false });
    expect(spoken).not.toContain('Would you like a text');
    expect(toolsByTurn.flat()).not.toContain('order_text_updates');
  });
});
