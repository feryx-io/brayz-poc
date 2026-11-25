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
 * Answering the latest thing the caller said.
 *
 * A caller who cuts in and then keeps talking produces two finals a second
 * apart — too far apart for the settle window to merge. The first starts a
 * turn; the second used to wait behind it, so the caller heard a reply to
 * something they had already moved past. On a live call (2026-08-31) that meant
 * being asked which sauce they wanted after they had named it, and saying it
 * again.
 */
class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}

/** Thinks slowly on the first turn, so a second utterance lands mid-think. */
class StallingLlm implements LlmProvider {
  readonly name = 'fake-llm';
  calls = 0;
  seen: LlmMessage[][] = [];
  aborted = 0;
  /** Resolved by the test to let the first turn finish thinking. */
  release = () => {};
  private held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

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
    opts.onEvent({ type: 'text', textDelta: 'Which sauce would you like?' });
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  framesPerUtterance = 1;
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    for (let i = 0; i < this.framesPerUtterance; i++) opts.onAudio(new Uint8Array(320));
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
  const llm = new StallingLlm();
  const tts = new FakeTts();
  let framesSent = 0;
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-stale', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => (framesSent += 1), send: () => {} },
    log: pino({ level: 'silent' }),
  });
  return { engine, stt, llm, tts, framesSent: () => framesSent };
}

describe('Conversation engine — a turn that has not spoken yet', () => {
  it('is replaced by what the caller said next, not queued behind', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    const greeting = tts.spoken.length;

    stt.onSegment!({ text: 'I know', isFinal: true });
    await waitFor(() => llm.calls === 1); // thinking, nothing said yet

    stt.onSegment!({ text: "let's go barbecue", isFinal: true });
    await waitFor(() => llm.calls === 2);

    // The stalled turn was dropped rather than left to answer a question the
    // caller had already answered.
    expect(llm.aborted).toBe(1);
    const said = [...llm.seen[1]!].filter((m) => m.role === 'user').map((m) => m.content);
    expect(said).toEqual(['I know', "let's go barbecue"]);

    // And only one reply is spoken: the caller never hears the stale one.
    llm.release();
    await new Promise((r) => setTimeout(r, 100));
    expect(tts.spoken.length).toBe(greeting + 1);
    await engine.stop();
  }, 15_000);

  it('is still replaced when its audio is synthesized but nothing has reached the wire', async () => {
    // The call of 2026-09-04 23:27: "One large pizza." — the model asked what
    // toppings — "Half sausage, half mushrooms." arrived while that question
    // was buffered, half a second from the wire. TTS had produced frames, so
    // the old test called the turn "speaking" and queued the answer behind a
    // question the caller had just answered.
    const { engine, stt, llm, tts, framesSent } = buildEngine();
    tts.framesPerUtterance = 5;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await waitFor(() => framesSent() >= 5, 2000); // the greeting is playing
    await new Promise((r) => setTimeout(r, 500)); // ...and has played out
    const afterGreeting = framesSent();

    stt.onSegment!({ text: 'One large pizza.', isFinal: true });
    await waitFor(() => llm.calls === 1);
    // The model answers; TTS produces the question's frames at once, and the
    // pump holds them for its lead time before the first goes out.
    llm.release();
    await waitFor(() => tts.spoken.length === 2);
    expect(framesSent()).toBe(afterGreeting);

    stt.onSegment!({ text: 'Half sausage, half mushrooms.', isFinal: true });
    await waitFor(() => llm.calls === 2, 2000);
    const secondTurn = llm.seen[1]!;
    expect(secondTurn.at(-1)).toMatchObject({ role: 'user', content: 'Half sausage, half mushrooms.' });
    // The abandoned question never reached the history...
    expect(secondTurn.filter((m) => m.role === 'assistant').map((m) => m.content)).not.toContain(
      'Which sauce would you like?',
    );
    // ...and its buffered audio never reached the caller: only the reply to
    // the second utterance plays.
    await waitFor(() => framesSent() >= afterGreeting + 5, 2000);
    await new Promise((r) => setTimeout(r, 400));
    expect(framesSent()).toBe(afterGreeting + 5);
    await engine.stop();
  }, 15_000);

  it('is left alone once a tool has run, since that turn has already done something', async () => {
    const stt = new FakeStt();
    const tts = new FakeTts();
    let placed = 0;
    // Calls a tool on the first turn, then stalls inside it.
    let releaseTool = () => {};
    const heldTool = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const llm: LlmProvider = {
      name: 'fake-llm',
      calls: 0,
      async stream(opts: { messages: LlmMessage[]; onEvent: (e: LlmStreamEvent) => void }) {
        (this as { calls: number }).calls += 1;
        if ((this as { calls: number }).calls === 1) {
          opts.onEvent({
            type: 'tool_call',
            toolCall: { id: 't1', name: 'lookup_hours', arguments: {} },
          });
        } else {
          opts.onEvent({ type: 'text', textDelta: 'We close at nine.' });
        }
        opts.onEvent({ type: 'done' });
      },
    } as LlmProvider & { calls: number };
    const engine = new ConversationEngine({
      providers: { stt, llm, tts },
      context: { callId: 'call-stale-2', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      toolExecutor: async () => {
        placed += 1;
        await heldTool;
        return 'Monday: 11 AM to 9 PM.';
      },
    });

    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'when do you close', isFinal: true });
    await waitFor(() => placed === 1); // inside the tool, still silent

    stt.onSegment!({ text: 'and where are you', isFinal: true });
    await new Promise((r) => setTimeout(r, 400)); // past the settle window

    // The turn ran a tool, so it owns what happens next: the new utterance
    // waits rather than discarding work that already had an effect.
    expect(placed).toBe(1);
    releaseTool();
    await engine.stop();
  }, 15_000);
});
