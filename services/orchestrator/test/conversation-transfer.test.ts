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
import { ConversationEngine, type TransferTarget } from '../src/conversation.js';
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
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    opts.onAudio(new Uint8Array(320));
  }
}
/** Asks to reach a manager by emitting transfer_call with that key, then closes out. */
class TransferLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    if (opts.messages.some((m) => m.role === 'tool')) {
      opts.onEvent({ type: 'text', textDelta: 'One moment, connecting you.' });
      opts.onEvent({ type: 'done' });
    } else {
      opts.onEvent({ type: 'tool_call', toolCall: { id: 't1', name: 'transfer_call', arguments: { target: 'manager' } } });
      opts.onEvent({ type: 'done' });
    }
  }
}

const TARGETS: TransferTarget[] = [
  { key: 'manager', label: 'a manager', sipUri: 'sip:+15185550000@trunk.test' },
  { key: 'bob', label: 'Bob, the owner', sipUri: 'sip:bob@pbx.example.com' },
];

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Conversation engine — per-location transfer routing', () => {
  let media: MediaServerHandle;
  let port: number;
  let stt: FakeStt;

  beforeAll(async () => {
    stt = new FakeStt();
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({
        providers: { stt, llm: new TransferLlm(), tts: new FakeTts() },
        context,
        io,
        log,
        loadTransferTargets: async () => TARGETS,
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

  it('REFERs the caller to the SIP URI of the option the LLM picked by key', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    let greeted = false;
    let transferTarget: string | undefined;
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (isBinary) {
        greeted = true;
        return;
      }
      const msg = JSON.parse(d.toString());
      if (msg.type === 'transfer') transferTarget = msg.target;
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });

    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-tr1',
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );

    await waitFor(() => greeted && stt.onSegment !== undefined);
    stt.onSegment!({ text: 'I need to talk to a manager', isFinal: true });

    await waitFor(() => transferTarget !== undefined);
    expect(transferTarget).toBe('sip:+15185550000@trunk.test');

    ws.close();
  });
});

/**
 * A location with nobody to transfer to is never offered a transfer. On the
 * call of 2026-09-14 19:23 (Saratoga, no transfer options) the bot told a
 * caller "I'd be happy to transfer you", because the tool was always there and
 * the prompt always said to offer one.
 */
describe('Conversation engine — no transfer options', () => {
  /** Records what each pass was given, and answers without tools. */
  class RecordingLlm implements LlmProvider {
    readonly name = 'fake-llm';
    tools: string[] = [];
    system = '';
    async stream(opts: {
      messages: { role: string; content: string }[];
      tools?: { name: string }[];
      onEvent: (e: LlmStreamEvent) => void;
    }): Promise<void> {
      this.tools = (opts.tools ?? []).map((t) => t.name);
      this.system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      opts.onEvent({ type: 'text', textDelta: 'OK.' });
      opts.onEvent({ type: 'done' });
    }
  }

  async function passWith(targets: TransferTarget[]) {
    const sttLocal = new FakeStt();
    const llm = new RecordingLlm();
    const states: string[] = [];
    const engine = new ConversationEngine({
      providers: { stt: sttLocal, llm, tts: new FakeTts() },
      context: { callId: 'call-no-transfer', sampleRate: 8000, restaurantName: "Jimmy's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadTransferTargets: async () => targets,
      loadPersonas: async () => ['Jose', 'Sarah'],
      onStateChange: (s) => states.push(s),
    });
    await engine.start();
    await waitFor(() => states.includes('listening'), 3000);
    sttLocal.onSegment!({ text: 'Is Mike there?', isFinal: true });
    await waitFor(() => llm.tools.length > 0, 3000);
    await engine.stop();
    return llm;
  }

  it('does not offer transfer_call or tell the model to offer a transfer', async () => {
    const llm = await passWith([]);
    expect(llm.tools).not.toContain('transfer_call');
    expect(llm.system).toContain('never offer a transfer');
    expect(llm.system).not.toContain('offer to transfer them to staff');
    expect(llm.system).toMatch(/Only these names; anyone else is a\s+message\./);
  });

  it('keeps both for a location that has somewhere to send the call', async () => {
    const llm = await passWith(TARGETS);
    expect(llm.tools).toContain('transfer_call');
    expect(llm.system).toContain('offer to transfer them to staff');
    expect(llm.system).toMatch(/anyone else is a\s+transfer or a message\./);
  });
});
