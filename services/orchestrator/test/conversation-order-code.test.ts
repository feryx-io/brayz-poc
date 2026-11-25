import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  LlmMessage,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * The confirmation code is said, not merely asked for.
 *
 * The tool result tells the model to read the code back, and the model usually
 * does — but only usually. Measured against the live model it left the code out
 * of about one reply in ten, and on the call of 2026-09-01 the caller had to ask
 * for it after being wished a good day. Rewording the instruction did not move
 * that rate, so the guarantee belongs in the turn, next to the other things the
 * tools decide rather than the prompt (rule #5).
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

/** Holds one line mid-playout, so a barge-in can land on it. */
class HoldingTts extends FakeTts {
  held = false;
  private gate = () => {};
  private opened = new Promise<void>((resolve) => {
    this.gate = resolve;
  });
  constructor(private readonly hold: string) {
    super();
  }
  override async synthesize(opts: {
    text: string;
    onAudio: (f: AudioFrame) => void;
  }): Promise<void> {
    await super.synthesize(opts);
    if (opts.text.includes(this.hold) && !this.held) {
      this.held = true;
      await this.opened;
    }
  }
  release(): void {
    this.gate();
  }
}

/**
 * Adds an item and reads it back, places the order once the caller answers,
 * then signs off with whatever it is given. Two caller turns, because the
 * engine will not place an order in the same turn it was read back in.
 */
class SignOffLlm implements LlmProvider {
  readonly name = 'fake-llm';
  constructor(private readonly closing: string) {}
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const done = opts.messages.filter((m) => m.role === 'tool').length;
    const turns = opts.messages.filter((m) => m.role === 'user').length;
    if (turns <= 1) {
      if (done === 0) {
        opts.onEvent({
          type: 'tool_call',
          toolCall: { id: 'a1', name: 'add_item', arguments: { item: 'Large Pepperoni', quantity: 1 } },
        });
      } else if (done === 1) {
        opts.onEvent({ type: 'tool_call', toolCall: { id: 'r1', name: 'review_order', arguments: { customer_name: 'Sam' } } });
      } else {
        opts.onEvent({ type: 'text', textDelta: 'Shall I place that for you?' });
      }
    } else if (done === 2) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: 'p1', name: 'place_order', arguments: { customer_name: 'Sam' } },
      });
    } else {
      opts.onEvent({ type: 'text', textDelta: this.closing });
    }
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [{ id: 'mi-1', name: 'Large Pepperoni', priceCents: 1800 }];

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Place an order through a model that signs off with `closing`. */
async function placeOrderSigningOff(closing: string, orderCode = 'DDB37'): Promise<string[]> {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const states: string[] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm: new SignOffLlm(closing), tts },
    context: { callId: 'call-code', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    // Asserts on what the tool says back to the model, which only reaches the
    // caller when the location has asked the AI to word confirmations.
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    placeOrder: async () => ({ orderCode, totalCents: 1800 }),
    onStateChange: (s) => states.push(s),
  });
  await engine.start();
  await waitFor(() => stt.onSegment !== undefined);
  await waitFor(() => states.includes('listening'));

  const mark = states.length;
  stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
  await waitFor(() => states.slice(mark).includes('thinking'));
  await waitFor(() => states.slice(mark).at(-1) === 'listening');

  // The read-back has been spoken; the order is placed on the answer to it.
  const answered = states.length;
  stt.onSegment!({ text: 'yes, place it under Sam', isFinal: true });
  await waitFor(() => states.slice(answered).includes('thinking'));
  await waitFor(() => states.slice(answered).at(-1) === 'listening');
  await engine.stop();
  return tts.spoken;
}

describe('Conversation engine — the confirmation code', () => {
  it('is spoken even when the reply forgets it', async () => {
    const spoken = await placeOrderSigningOff("You're all set! See you in about fifteen minutes.");
    expect(spoken.some((s) => /confirmation code is D D B 3 7/.test(s))).toBe(true);
  });

  it('is not read a second time when the reply already gave it', async () => {
    const spoken = await placeOrderSigningOff(
      "You're all set — your code is D-D-B-3-7. See you soon!",
    );
    expect(spoken.some((s) => /confirmation code is/i.test(s))).toBe(false);
  });

  it('counts a code the reply spelled with number words', async () => {
    const spoken = await placeOrderSigningOff('All set, your code is D D B three seven. Bye!');
    expect(spoken.some((s) => /confirmation code is/i.test(s))).toBe(false);
  });

  it('reads it properly when the reply ran the characters together', async () => {
    // The live failure (2026-09-02 18:44): "confirmation code F489-1" has every
    // character in order, and a TTS voice reads it as "F four eighty-nine dash
    // one". Having the characters is not the same as reading them out.
    const spoken = await placeOrderSigningOff("You're all set — code DDB37. See you soon!");
    expect(spoken.some((s) => /confirmation code is D D B 3 7/.test(s))).toBe(true);
  });

  it('accepts a code the reply padded out for clarity', async () => {
    const spoken = await placeOrderSigningOff('Your code is D, D, B, 3, 7 — see you soon!');
    expect(spoken.some((s) => /confirmation code is/i.test(s))).toBe(false);
  });

  it('survives an interruption instead of being lost with the reply', async () => {
    // An interrupted turn gives way rather than forcing the code over a talking
    // caller — so the debt has to outlive the turn, or the code dies with it.
    const stt = new FakeStt();
    const tts = new HoldingTts("You're all set, see you soon!");
    const states: string[] = [];
    const engine = new ConversationEngine({
      providers: { stt, llm: new SignOffLlm("You're all set, see you soon!"), tts },
      context: { callId: 'call-code-cut', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => MENU,
      // Asserts on what the tool says back to the model, which only reaches the
      // caller when the location has asked the AI to word confirmations.
      loadProfile: async () => ({ orderAckMode: 'natural' as const }),
      placeOrder: async () => ({ orderCode: 'ZZ9', totalCents: 1800 }),
      onStateChange: (s) => states.push(s),
    });
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await waitFor(() => states.includes('listening'));

    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Shall I place that/.test(s)));
    stt.onSegment!({ text: 'yes, place it under Sam', isFinal: true });
    await waitFor(() => tts.held); // the sign-off is on the wire

    await engine.bargeIn();
    stt.onSegment!({ text: 'wait, what was that', isFinal: true });
    tts.release();

    await waitFor(() => tts.spoken.some((s) => /confirmation code is Z Z 9/.test(s)), 10_000);
    // Paid by the turn that answered the caller, not by the one they cut off.
    expect(tts.spoken.findIndex((s) => /confirmation code is Z Z 9/.test(s))).toBeGreaterThan(
      tts.spoken.indexOf("You're all set, see you soon!"),
    );
    await engine.stop();
  });
});
