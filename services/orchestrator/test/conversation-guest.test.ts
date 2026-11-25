import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  LlmToolCall,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { createMediaServer, type ConversationFactory, type MediaServerHandle } from '../src/mediaServer.js';
import { ConversationEngine, type GuestInfo, type ToolExecutor } from '../src/conversation.js';
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
/** Calls save_guest_memory on a user turn, then relays the tool result as speech. */
class GuestLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const last = opts.messages[opts.messages.length - 1];
    if (last.role === 'tool') {
      for (const ch of last.content.match(/[\s\S]{1,8}/g) ?? []) opts.onEvent({ type: 'text', textDelta: ch });
      opts.onEvent({ type: 'done' });
      return;
    }
    opts.onEvent({
      type: 'tool_call',
      toolCall: { id: 'g1', name: 'save_guest_memory', arguments: { note: 'allergic to nuts' } },
    });
    opts.onEvent({ type: 'done' });
  }
}

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Conversation engine — guest memory', () => {
  let media: MediaServerHandle | undefined;
  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  async function startCall(guest: GuestInfo) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const executed: LlmToolCall[] = [];
    const executor: ToolExecutor = async (call) => {
      executed.push(call);
      return 'Got it, I’ll remember that.';
    };
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({
        providers: { stt, llm: new GuestLlm(), tts },
        context,
        io,
        log,
        toolExecutor: executor,
        loadGuest: async () => guest,
      });
    media = createMediaServer({
      log: pino({ level: 'silent' }),
      persistence: new SpyPersistence(),
      nodeId: 'test',
      conversationFactory: factory,
    });
    const port = await media.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-guest1',
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );
    await waitFor(() => stt.onSegment !== undefined && tts.spoken.length >= 1); // greeting done
    return { ws, stt, tts, executed };
  }

  it('greets a recognized returning guest by name and saves new memory via the tool', async () => {
    const { ws, stt, tts, executed } = await startCall({ isReturning: true, displayName: 'Mike', mode: 'full' });

    expect(tts.spoken.some((s) => s.includes('Welcome back, Mike'))).toBe(true);

    stt.onSegment!({ text: 'just so you know I am allergic to nuts', isFinal: true });
    await waitFor(() => executed.some((c) => c.name === 'save_guest_memory'));
    const saved = executed.find((c) => c.name === 'save_guest_memory')!;
    expect(saved.arguments.note).toBe('allergic to nuts');
    await waitFor(() => tts.spoken.some((s) => /remember that/i.test(s)));

    ws.close();
  });

  it('does not greet by name when the caller is not a recognized guest', async () => {
    const { ws, tts } = await startCall({ isReturning: false, mode: 'off' });
    expect(tts.spoken.some((s) => s.includes('Welcome back'))).toBe(false);
    expect(tts.spoken.some((s) => /thanks for calling/i.test(s))).toBe(true);
    ws.close();
  });
});
