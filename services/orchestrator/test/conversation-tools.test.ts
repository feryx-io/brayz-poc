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
import { ConversationEngine, type ToolExecutor } from '../src/conversation.js';
import type { CallPersistence } from '../src/persistence.js';

class SpyPersistence implements CallPersistence {
  async ensureCall(input: { callId?: string }) {
    return { id: input.callId ?? 'call-1', tenantId: 't', locationId: 'l' };
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
class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    opts.onAudio(new Uint8Array(320));
  }
}
/** First turn calls a tool; once the tool result is in context, it answers. */
class ToolThenAnswerLlm implements LlmProvider {
  readonly name = 'fake-llm';
  sawToolResult = false;
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    if (opts.messages.some((m) => m.role === 'tool')) {
      this.sawToolResult = true;
      for (const ch of 'We are open until 9 tonight.'.match(/.{1,4}/g) ?? []) {
        opts.onEvent({ type: 'text', textDelta: ch });
      }
      opts.onEvent({ type: 'done' });
    } else {
      opts.onEvent({ type: 'tool_call', toolCall: { id: 't1', name: 'lookup_hours', arguments: {} } });
      opts.onEvent({ type: 'done' });
    }
  }
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Conversation engine — agentic tool loop', () => {
  let media: MediaServerHandle;
  let port: number;
  let stt: FakeStt;
  let tts: FakeTts;
  const executed: string[] = [];

  beforeAll(async () => {
    stt = new FakeStt();
    tts = new FakeTts();
    const executor: ToolExecutor = async (call) => {
      executed.push(call.name);
      return 'Monday: 11 AM to 9 PM.';
    };
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({
        providers: { stt, llm: new ToolThenAnswerLlm(), tts },
        context,
        io,
        log,
        toolExecutor: executor,
      });
    media = createMediaServer({
      log: pino({ level: 'silent' }),
      persistence: new SpyPersistence(),
      nodeId: 'test',
      conversationFactory: factory,
    });
    port = await media.listen(0);
  });
  afterAll(async () => {
    await media.close();
  });

  it('runs a tool call then speaks the answer derived from the result', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-3c4d5e',
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );

    await waitFor(() => stt.onSegment !== undefined && tts.spoken.length >= 1); // greeting done
    stt.onSegment!({ text: 'What are your hours?', isFinal: true });

    await waitFor(() => executed.includes('lookup_hours') && tts.spoken.includes('We are open until 9 tonight.'));
    expect(executed).toEqual(['lookup_hours']);
    expect(tts.spoken).toContain('We are open until 9 tonight.');

    ws.close();
  });
});
