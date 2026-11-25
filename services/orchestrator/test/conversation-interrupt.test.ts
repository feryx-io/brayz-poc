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
import { ConversationEngine, type ToolExecutor } from '../src/conversation.js';

/**
 * What a turn leaves behind when the caller cuts it off. A barge-in aborts the
 * turn mid-reply, and everything the turn would have recorded — the words the
 * caller heard, the answers to the tools it called — is written after that
 * point. Dropping it left the call history missing the half-reply the caller
 * was responding to, and left the model's own history holding a tool call with
 * no result, which a real provider rejects outright.
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
  reply = 'One large Big Kahuna. One order of boneless wings. Your total is forty eight dollars.';
  /** Tool calls to make on the first turn only, so the loop terminates. */
  firstTurnTools: Array<{ id: string; name: string }> = [];
  /** Per-request replies, when a test needs each pass to say something different. */
  replies: string[] = [];
  calls = 0;
  /** The history as of the most recent request. */
  seen: LlmMessage[] = [];

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.calls += 1;
    this.seen = opts.messages.map((m) => ({ ...m }));
    opts.onEvent({ type: 'text', textDelta: this.replies[this.calls - 1] ?? this.reply });
    if (this.calls === 1) {
      for (const t of this.firstTurnTools) {
        opts.onEvent({ type: 'tool_call', toolCall: { id: t.id, name: t.name, arguments: {} } });
      }
    }
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  /** 20 ms frames per sentence; the pump paces them out one per 20 ms. */
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

function buildEngine(toolExecutor?: ToolExecutor) {
  const stt = new FakeStt();
  const llm = new FakeLlm();
  const tts = new FakeTts();
  const transcript: Array<{ speaker: string; text: string }> = [];
  const sent = { frames: 0 };
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-int', sampleRate: 8000, restaurantName: "Mario's" },
    io: {
      sendAudio: () => {
        sent.frames += 1;
      },
      send: () => {},
    },
    log: pino({ level: 'silent' }),
    toolExecutor,
    onTranscript: (segment, speaker) => {
      if (segment.isFinal) transcript.push({ speaker, text: segment.text });
    },
  });
  return { engine, stt, llm, tts, transcript, sent };
}

describe('Conversation engine — a turn the caller cut off', () => {
  it('records the part of the reply the caller actually heard', async () => {
    const { engine, stt, llm, tts, transcript, sent } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 80; // 1.6 s a sentence — slow enough to interrupt
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'read that back to me', isFinal: true });
    await waitFor(() => llm.calls === 1);
    const before = sent.frames;
    await waitFor(() => sent.frames > before + 3); // into the first sentence

    await engine.bargeIn();
    stt.onSegment!({ text: 'wait stop', isFinal: true });
    await waitFor(() => llm.calls === 2);

    // Only the first sentence had started playing. The rest was still sitting
    // in the pump, so the caller never heard it and the record must not claim
    // they did — and the ellipsis says the reply was cut off, not finished.
    const agent = transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
    const cutOff = agent[agent.length - 1]!;
    expect(cutOff).toContain('One large Big Kahuna');
    expect(cutOff).not.toContain('forty eight dollars');
    expect(cutOff.endsWith('…')).toBe(true);

    // And the model is told what it said, so the next turn does not start over.
    const assistantSaid = llm.seen.filter((m) => m.role === 'assistant').map((m) => m.content);
    expect(assistantSaid.some((c) => c.includes('One large Big Kahuna'))).toBe(true);
    await engine.stop();
  }, 15_000);

  it('records only the sentences of the pass that was cut off', async () => {
    // A turn speaks, calls a tool, and speaks again — and each of those is
    // recorded as it finishes. When the playout positions were kept for the
    // whole turn rather than per pass, an interruption in the second pass
    // replayed the first pass's sentence too, and the transcript said it twice
    // (seen on the call of 2026-08-31 21:09).
    const { engine, stt, llm, tts, transcript, sent } = buildEngine(async () => 'Monday: 11 to 9.');
    llm.firstTurnTools = [{ id: 't1', name: 'lookup_hours' }];
    llm.replies = [
      'Let me check that for you.',
      'One large Big Kahuna. One order of boneless wings. Your total is forty eight dollars.',
    ];
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 60;
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'read that back to me', isFinal: true });
    await waitFor(() => llm.calls === 2); // the tool ran; the second pass is speaking
    const before = sent.frames;
    await waitFor(() => sent.frames > before + 3);

    await engine.bargeIn();
    stt.onSegment!({ text: 'wait stop', isFinal: true });
    await waitFor(() => llm.calls === 3);

    const agent = transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
    const cutOff = agent[agent.length - 1]!;
    expect(cutOff).toContain('One large Big Kahuna');
    // The first pass was already recorded on its own; it is not said again.
    expect(cutOff).not.toContain('Let me check that for you');
    expect(agent.filter((t) => t.includes('Let me check that for you'))).toHaveLength(1);
    await engine.stop();
  }, 15_000);

  it('answers every tool call it made, even the ones the interruption stopped', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executed = 0;
    const executor: ToolExecutor = async () => {
      executed += 1;
      if (executed === 1) await held; // hold the turn open inside the tool loop
      return 'Monday: 11 AM to 9 PM.';
    };
    const { engine, stt, llm, tts, sent } = buildEngine(executor);
    llm.firstTurnTools = [
      { id: 't1', name: 'lookup_hours' },
      { id: 't2', name: 'lookup_restaurant_profile' },
    ];
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 2;
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'when do you close', isFinal: true });
    await waitFor(() => executed === 1); // inside the tool loop now
    await waitFor(() => sent.frames > 0);

    // The caller cuts in while the first tool is still running.
    await engine.bargeIn();
    stt.onSegment!({ text: 'never mind about that', isFinal: true });
    await new Promise((r) => setTimeout(r, 50));
    release();

    await waitFor(() => llm.calls === 2);
    // Every tool call the assistant made has an answer. Without that, this
    // history is a 400 and the call ends on the provider-failure path.
    const called = llm.seen.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id));
    const answered = llm.seen.filter((m) => m.role === 'tool').map((m) => m.toolCallId);
    expect(called).toEqual(['t1', 't2']);
    expect(answered).toEqual(called);
    // The interruption still stopped the work: only the running tool ever ran.
    expect(executed).toBe(1);
    await engine.stop();
  }, 15_000);
});
