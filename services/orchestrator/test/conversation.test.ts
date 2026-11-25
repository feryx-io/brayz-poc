import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { createMediaServer, type ConversationFactory, type MediaServerHandle } from '../src/mediaServer.js';
import { ConversationEngine } from '../src/conversation.js';
import type { CallPersistence } from '../src/persistence.js';

/**
 * Fake-Siphon harness + fake providers: proves the conversation engine greets,
 * turns a final transcript into an LLM turn, synthesizes the reply to PCM frames,
 * and aborts on barge-in — without touching Deepgram or Anthropic.
 */
class SpyPersistence implements CallPersistence {
  async ensureCall(input: { callId?: string; toNumber: string }) {
    return { id: input.callId ?? 'call-1', tenantId: 'tenant-1', locationId: 'loc-1' };
  }
  async postEvent() {}
  async completeCall() {}
}

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
  turns: string[] = [];
  reply = 'We are open until 9 tonight.';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    this.turns.push(lastUser?.content ?? '');
    for (const ch of this.reply.match(/.{1,5}/g) ?? []) opts.onEvent({ type: 'text', textDelta: ch });
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    // 300 ms of audio per sentence, so the barge-in below lands while the
    // reply is still playing: a speech_started with nothing of ours on the
    // wire is not an interruption and is (rightly) ignored.
    for (let i = 0; i < 15; i++) opts.onAudio(new Uint8Array(320));
  }
}

const CALL_ID = 'siphon-2b3c4d'; // SiphonAI internal id (non-UUID)

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Conversation engine (fake providers over fake Siphon)', () => {
  let media: MediaServerHandle;
  let port: number;
  let stt: FakeStt;
  let llm: FakeLlm;
  let tts: FakeTts;

  beforeAll(async () => {
    stt = new FakeStt();
    llm = new FakeLlm();
    tts = new FakeTts();
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({ providers: { stt, llm, tts }, context, io, log });
    media = createMediaServer({
      log: pino({ level: 'silent' }),
      persistence: new SpyPersistence(),
      nodeId: 'test-node',
      conversationFactory: factory,
    });
    port = await media.listen(0);
  });
  afterAll(async () => {
    await media.close();
  });

  it('greets, answers a transcript, synthesizes audio, and aborts on barge-in', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    let binaryFrames = 0;
    const controls: string[] = [];
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (isBinary) binaryFrames += 1;
      else controls.push(d.toString());
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: CALL_ID,
        seq: 0,
        from: '+15185551212',
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
        sip: { call_id: 'abc123@pbx.example.com' },
      }),
    );

    // Greeting played: TTS spoke it and PCM frames came back over the socket.
    // It is synthesized sentence by sentence, so read it as a whole line.
    await waitFor(() => /how can i help/i.test(tts.spoken.join(' ')) && binaryFrames >= 2);

    // Caller finishes an utterance -> the engine runs an LLM turn and speaks the reply.
    await waitFor(() => stt.onSegment !== undefined);
    const greeted = tts.spoken.length;
    stt.onSegment!({ text: 'Are you open right now?', isFinal: true });

    await waitFor(() => llm.turns.length >= 1 && tts.spoken.length > greeted);
    expect(llm.turns[0]).toBe('Are you open right now?');
    expect(tts.spoken).toContain('We are open until 9 tonight.');
    // Playout is paced (one frame / 20 ms), so wait for the reply frames to send.
    await waitFor(() => binaryFrames >= 4); // greeting + reply frames

    // SiphonAI speech_started -> engine aborts the turn and flushes via `clear`.
    const gotClear = new Promise<void>((resolve) => {
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        if (!isBinary && d.toString().includes('"type":"clear"')) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'speech_started', call_id: CALL_ID, seq: 1 }));
    await gotClear;

    ws.close();
  });
});
