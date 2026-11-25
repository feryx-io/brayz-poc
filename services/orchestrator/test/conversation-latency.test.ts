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
 * Per-turn timing. The engine had none, so every gap on a real call was
 * reconstructed afterwards from word counts against an assumed speech rate —
 * which was wrong by 20%, and turned a 4-second gap into a reported 5.5.
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

/** Waits `delayMs` before its first event, so time-to-first-byte is a known quantity. */
class SlowLlm implements LlmProvider {
  readonly name = 'fake-llm';
  delayMs = 120;
  callTool = false;
  calls = 0;
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.callTool && this.calls === 1) {
      opts.onEvent({ type: 'tool_call', toolCall: { id: 't1', name: 'lookup_hours', arguments: {} } });
    } else {
      opts.onEvent({ type: 'text', textDelta: 'We are open until nine.' });
    }
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

interface TurnLine {
  msg: string;
  turn: number;
  deadAirMs: number | null;
  modelMs: number;
  passMs: number[];
  spokeMs: number | null;
  tools: number;
  aborted?: boolean;
}

function buildEngine() {
  const stt = new FakeStt();
  const llm = new SlowLlm();
  const lines: TurnLine[] = [];
  const log = pino(
    { level: 'info' },
    {
      write(s: string) {
        const rec = JSON.parse(s);
        if (rec.msg === 'turn latency') lines.push(rec);
      },
    },
  );
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-lat', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log,
    toolExecutor: async () => 'Open until nine.',
  });
  return { engine, stt, llm, lines };
}

describe('Conversation engine — turn latency', () => {
  it('reports the caller’s dead air, split into model time and everything else', async () => {
    const { engine, stt, llm, lines } = buildEngine();
    llm.delayMs = 150;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'when do you close', isFinal: true });
    await waitFor(() => lines.length === 1);

    const t = lines[0]!;
    expect(t.turn).toBe(1);
    expect(t.tools).toBe(0);
    expect(t.passMs).toHaveLength(1);
    // One model round trip, and the engine's own share is what is left over.
    expect(t.passMs[0]).toBeGreaterThanOrEqual(140);
    expect(t.modelMs).toBe(t.passMs[0]);
    expect(t.deadAirMs).toBeGreaterThanOrEqual(t.modelMs);
    expect(t.spokeMs).toBe(t.deadAirMs! - t.modelMs);
    await engine.stop();
  }, 15_000);

  it('shows a tool turn paying for two round trips, not one', async () => {
    // The shape that made tool turns look unexplained on the call of
    // 2026-09-02: add_item is engine-held, so it leaves no trace in the API
    // logs, and the turn's two model round trips read as one slow one.
    const { engine, stt, llm, lines } = buildEngine();
    llm.delayMs = 120;
    llm.callTool = true;
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'when do you close', isFinal: true });
    await waitFor(() => lines.length === 1);

    const t = lines[0]!;
    expect(t.tools).toBe(1);
    expect(t.passMs).toHaveLength(2);
    expect(t.modelMs).toBe(t.passMs[0]! + t.passMs[1]!);
    await engine.stop();
  }, 15_000);

  it('counts each caller turn separately', async () => {
    const { engine, stt, lines } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'when do you close', isFinal: true });
    await waitFor(() => lines.length === 1);
    stt.onSegment!({ text: 'and where are you', isFinal: true });
    await waitFor(() => lines.length === 2);

    expect(lines.map((l) => l.turn)).toEqual([1, 2]);
    await engine.stop();
  }, 15_000);
});
