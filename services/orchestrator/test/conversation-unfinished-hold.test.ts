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
import { ConversationEngine, extendsUtterance, looksUnfinished } from '../src/conversation.js';

/**
 * The run-up to a sentence is not a sentence.
 *
 * On the call of 2026-09-02 18:10 the caller said "Actually," — paused — "let's
 * change that to barbecue." The pause outlasted the settle window, so the
 * fragment was answered on its own ("what would you like to change?"), and by
 * the time the rest arrived that reply was already on the wire. It queued
 * behind it: eleven seconds from saying it to being answered.
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

class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  /** What each turn was asked to answer, in order. */
  answered: string[] = [];
  /** Every caller line in the history the model was sent, per pass. */
  histories: string[][] = [];
  /** Think this long before answering — a slow model pass. */
  thinkMs = 0;
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    this.answered.push(lastUser?.content ?? '');
    this.histories.push(opts.messages.filter((m) => m.role === 'user').map((m) => m.content));
    if (this.thinkMs) await new Promise((r) => setTimeout(r, this.thinkMs));
    if (opts.signal?.aborted) return opts.onEvent({ type: 'done' });
    opts.onEvent({ type: 'text', textDelta: 'Sure.' });
    opts.onEvent({ type: 'done' });
  }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine() {
  const stt = new FakeStt();
  const llm = new FakeLlm();
  const sent: string[] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-unfinished', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: (m) => sent.push((m as { type: string }).type) },
    log: pino({ level: 'silent' }),
  });
  return { engine, stt, llm, sent };
}

describe('looksUnfinished', () => {
  it('knows the run-up from the whole thing', () => {
    for (const t of ['Actually,', 'Can I get a', 'and', 'I want a pizza with', 'Hmm', 'How about', 'What about']) {
      expect(looksUnfinished(t)).toBe(true);
    }
    // These are complete answers a caller must never be made to wait on.
    for (const t of ['Large.', 'No', 'Yes please', "That's it.", 'Boneless wings', 'Garlic Parmesan']) {
      expect(looksUnfinished(t)).toBe(false);
    }
  });
});

describe('Conversation engine — an utterance that has not finished', () => {
  it('waits for the rest of the sentence and answers it as one', async () => {
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'Actually,', isFinal: true });
    // Longer than the settle window, shorter than the hold: the old code had
    // already replied by now.
    await new Promise((r) => setTimeout(r, 600));
    expect(llm.answered).toHaveLength(0);

    stt.onSegment!({ text: "let's change that to barbecue.", isFinal: true });
    await waitFor(() => llm.answered.length === 1);

    expect(llm.answered[0]).toBe("Actually, let's change that to barbecue.");
    await engine.stop();
  }, 15_000);

  it('waits through "How about" for the thing itself', async () => {
    // The call of 2026-09-11 21:43: "How about" — a pause — "tacos? Do you have
    // tacos?". The fragment was answered on its own ("Go ahead, I'm listening —
    // what would you like to order?") and the question the caller actually
    // asked was not answered until 8.8 s after they finished asking it.
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'How about', isFinal: true });
    await new Promise((r) => setTimeout(r, 600));
    expect(llm.answered).toHaveLength(0);

    stt.onSegment!({ text: 'tacos? Do you have tacos?', isFinal: true });
    await waitFor(() => llm.answered.length === 1);

    expect(llm.answered[0]).toBe('How about tacos? Do you have tacos?');
    await engine.stop();
  }, 15_000);

  it('answers the whole sentence when its start was already being answered', async () => {
    // The call of 2026-09-14 14:20: "How about" waited out the hold and went to
    // the model on its own; "how about tomorrow at 6PM?" arrived while that
    // pass was still thinking, read as a repeat of it, and was dropped. The bot
    // said "Go ahead — what time were you thinking?" to a caller who had just
    // said the time.
    const { engine, stt, llm } = buildEngine();
    llm.thinkMs = 1200;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await waitFor(() => llm.answered.length === 0);

    stt.onSegment!({ text: 'How about', isFinal: true });
    await waitFor(() => llm.answered.length === 1, 4000);
    expect(llm.answered[0]).toBe('How about');

    stt.onSegment!({ text: 'how about tomorrow at 6PM?', isFinal: true });
    await waitFor(() => llm.answered.length === 2, 4000);

    expect(llm.answered[1]).toBe('how about tomorrow at 6PM?');
    // The fragment is not left in the history beside the whole sentence.
    expect(llm.histories[1]).not.toContain('How about');
    await engine.stop();
  }, 15_000);

  it('keeps the held words when the caller pauses and the VAD fires again', async () => {
    // The call of 2026-09-04 22:13: "Lettuce, tomato," — a breath — "cucumbers,"
    // — "and onion." The breath fired speech_started with nothing of ours
    // playing; the old code armed a barge-in on it, the next word confirmed an
    // interruption of nothing, and confirming threw the held words away. The
    // wrap got cucumber and onion.
    const { engine, stt, llm, sent } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting has played out by now; nothing of ours is on the wire.
    await new Promise((r) => setTimeout(r, 200));
    sent.length = 0;

    stt.onSegment!({ text: 'Lettuce, tomato,', isFinal: true });
    await new Promise((r) => setTimeout(r, 400));
    // The breath between items: SiphonAI's VAD, then STT's first interim.
    await engine.bargeIn();
    stt.onSegment!({ text: 'cucumbers', isFinal: false });
    stt.onSegment!({ text: 'cucumbers,', isFinal: true });
    await new Promise((r) => setTimeout(r, 300));
    stt.onSegment!({ text: 'and onion.', isFinal: true });
    await waitFor(() => llm.answered.length === 1, 4000);

    expect(llm.answered[0]).toBe('Lettuce, tomato, cucumbers, and onion.');
    // Nothing was interrupted, so nothing was cleared on the bridge either.
    expect(sent).not.toContain('clear');
    await engine.stop();
  }, 15_000);

  it('still answers a caller who really did just say that much', async () => {
    // The bounded half of the deal: nothing follows, so it is answered anyway.
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'Actually,', isFinal: true });
    await waitFor(() => llm.answered.length === 1, 4000);

    expect(llm.answered[0]).toBe('Actually,');
    await engine.stop();
  }, 15_000);

  it('does not make a complete answer wait', async () => {
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    const started = Date.now();
    stt.onSegment!({ text: 'Large.', isFinal: true });
    await waitFor(() => llm.answered.length === 1);

    expect(Date.now() - started).toBeLessThan(900);
    expect(llm.answered[0]).toBe('Large.');
    await engine.stop();
  }, 15_000);
});

describe('extendsUtterance', () => {
  it('is the same words with more after them', () => {
    expect(extendsUtterance('How about', 'how about tomorrow at 6PM?')).toBe(true);
    expect(extendsUtterance('Large pizza.', 'large pizza with pepperoni')).toBe(true);
  });
  it('is not a repeat, with or without a word in front', () => {
    expect(extendsUtterance('large pepperoni pizza', 'large pepperoni pizza')).toBe(false);
    expect(extendsUtterance('large pepperoni pizza', 'yes a large pepperoni pizza please')).toBe(false);
    expect(extendsUtterance('', 'anything')).toBe(false);
  });
});
