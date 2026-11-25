import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import type {
  AudioFrame,
  LlmProvider,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
} from '@brayz/ai';
import { createMediaServer, type ConversationFactory, type MediaServerHandle } from '../src/mediaServer.js';
import { ConversationEngine, OUT_OF_SERVICE_LINE } from '../src/conversation.js';
import type { CallPersistence, CallService } from '../src/persistence.js';

/**
 * An account whose free trial lapsed with no paid plan is out of service: the
 * AI does not take its calls. The API says so on the call it creates, and the
 * Orchestrator either rings the call through to the restaurant or tells the
 * caller, in one line, that it cannot be taken — and never opens STT or the model.
 */
class LapsedPersistence implements CallPersistence {
  events: string[] = [];
  constructor(private readonly service: CallService) {}
  async ensureCall() {
    return { id: 'call-1', tenantId: 't', locationId: 'l', service: this.service };
  }
  async postEvent(_callId: string, eventType: string) {
    this.events.push(eventType);
  }
  async appendTranscript() {}
  async setRecording() {}
  async completeCall() {}
}

class CountingStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  opened = 0;
  async openStream(): Promise<SttStreamHandle> {
    this.opened += 1;
    return { pushAudio() {}, async close() {} };
  }
}
class RecordingTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    opts.onAudio(new Uint8Array(320));
  }
}
class NeverLlm implements LlmProvider {
  readonly name = 'fake-llm';
  called = 0;
  async stream(): Promise<void> {
    this.called += 1;
  }
}

const START = {
  type: 'start',
  version: '1',
  call_id: 'siphon-lapsed',
  seq: 0,
  from: '+15555550100',
  to: '+15185550123',
  direction: 'inbound',
  audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
  sip: { call_id: 'lapsed@example.com', headers: {} },
};

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('media server — an account out of service', () => {
  let media: MediaServerHandle | undefined;
  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  async function call(service: CallService) {
    const stt = new CountingStt();
    const tts = new RecordingTts();
    const llm = new NeverLlm();
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({ providers: { stt, llm, tts }, context, io, log });
    const persistence = new LapsedPersistence(service);
    media = createMediaServer({ log: pino({ level: 'silent' }), persistence, conversationFactory: factory });
    const port = await media.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    const controls: Array<Record<string, unknown>> = [];
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (!isBinary) controls.push(JSON.parse(d.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify(START));
    return { ws, controls, stt, tts, llm, persistence };
  }

  it('rings the call through to the restaurant when it has somewhere to send it', async () => {
    const { ws, controls, stt, llm } = await call({
      inService: false,
      reason: 'trial_expired',
      forwardTo: 'sip:+15185551234@brayz.pstn.twilio.com',
    });
    await waitFor(() => controls.some((c) => c.type === 'transfer'));
    expect(controls.find((c) => c.type === 'transfer')).toMatchObject({
      target: 'sip:+15185551234@brayz.pstn.twilio.com',
      call_id: 'siphon-lapsed',
    });
    expect(stt.opened).toBe(0);
    expect(llm.called).toBe(0);
    ws.close();
  });

  it('tells the caller in one line and hangs up when there is nowhere to forward', async () => {
    const { ws, controls, stt, tts, llm } = await call({ inService: false, reason: 'trial_expired', forwardTo: null });
    await waitFor(() => controls.some((c) => c.type === 'hangup'));
    expect(tts.spoken).toEqual([OUT_OF_SERVICE_LINE]);
    expect(controls.find((c) => c.type === 'hangup')).toMatchObject({ call_id: 'siphon-lapsed' });
    expect(stt.opened).toBe(0);
    expect(llm.called).toBe(0);
    ws.close();
  });

  it('answers normally when the account is in service', async () => {
    const { ws, controls, stt } = await call({ inService: true, forwardTo: null });
    await waitFor(() => stt.opened === 1);
    expect(controls.some((c) => c.type === 'hangup' || c.type === 'transfer')).toBe(false);
    ws.close();
  });
});
