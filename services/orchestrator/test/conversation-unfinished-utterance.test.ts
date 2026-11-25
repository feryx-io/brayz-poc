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
 * Answering a whole thought, not the first half of one.
 *
 * STT closes a final at a pause, so "Actually," — pause — "I changed my mind,
 * can I get barbecue instead?" arrives as two finals seconds apart. On the live
 * call of 2026-09-01 the first one started a turn, the caller was asked what
 * they wanted to change, and from there every reply was a turn behind what they
 * had said. They repeated themselves twice more before the call caught up.
 *
 * The caller starting again (SiphonAI `speech_started`) before the turn has put
 * a sound on the wire is the signal that the thought is not over.
 */
class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}

class SlowLlm implements LlmProvider {
  readonly name = 'fake-llm';
  calls = 0;
  seen: LlmMessage[][] = [];
  aborted = 0;
  /** Held long enough that the turn is still silent when the caller resumes. */
  private held = new Promise<void>(() => {});

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    this.calls += 1;
    this.seen.push(opts.messages.map((m) => ({ ...m })));
    if (this.calls === 1) {
      await Promise.race([
        this.held,
        new Promise<void>((resolve) => opts.signal?.addEventListener('abort', () => resolve())),
      ]);
      if (opts.signal?.aborted) {
        this.aborted += 1;
        return;
      }
    }
    opts.onEvent({ type: 'text', textDelta: 'No problem.' });
    opts.onEvent({ type: 'done' });
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

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine(callId: string) {
  const stt = new FakeStt();
  const llm = new SlowLlm();
  const tts = new FakeTts();
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId, sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
  });
  return { engine, stt, llm, tts };
}

const userTurns = (messages: LlmMessage[]) =>
  messages.filter((m) => m.role === 'user').map((m) => m.content);

describe('Conversation engine — a caller who has not finished talking', () => {
  it('folds the fragment back in and answers the whole sentence once', async () => {
    const { engine, stt, llm } = buildEngine('call-unfinished');
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'Actually,', isFinal: true });
    await waitFor(() => llm.calls === 1); // answering the fragment, still silent

    // The caller carries on. Nothing has been said yet, so the turn is taken back.
    await engine.bargeIn();
    await new Promise((r) => setTimeout(r, 500)); // well past the settle window
    expect(llm.calls).toBe(1); // held: the caller is mid-sentence

    stt.onSegment!({ text: 'I changed my mind, can I get barbecue instead?', isFinal: true });
    await waitFor(() => llm.calls === 2);

    expect(llm.aborted).toBe(1);
    // One user turn carrying the whole thought — the fragment is not sent twice.
    expect(userTurns(llm.seen[1]!)).toEqual([
      'Actually, I changed my mind, can I get barbecue instead?',
    ]);
    await engine.stop();
  }, 15_000);

  it('answers the fragment anyway when the noise that held it says nothing', async () => {
    const { engine, stt, llm } = buildEngine('call-unfinished-2');
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'Actually,', isFinal: true });
    await waitFor(() => llm.calls === 1);

    await engine.bargeIn(); // the room, not the caller
    await new Promise((r) => setTimeout(r, 500));
    expect(llm.calls).toBe(1);

    engine.speechStopped(); // and nothing was said
    await waitFor(() => llm.calls === 2);
    expect(userTurns(llm.seen[1]!)).toEqual(['Actually,']);
    await engine.stop();
  }, 15_000);
});
