import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import { createMediaServer, type MediaServerHandle } from '../src/mediaServer.js';
import type { CallPersistence } from '../src/persistence.js';

/**
 * Fake-Siphon harness (implementation plan §18.3): a WS client that talks the
 * media protocol to the Orchestrator. Verifies the start handshake, frame
 * handling, barge-in -> clear_playback, and that call persistence is invoked.
 */
class SpyPersistence implements CallPersistence {
  ensureCalls: unknown[] = [];
  events: string[] = [];
  completed: string[] = [];
  transcript: Array<{ speaker: string; text: string }> = [];
  recordings: Array<{ recordingId?: string; recordingStatus: string }> = [];
  summaries: Array<string | null | undefined> = [];

  async ensureCall(input: { callId?: string; toNumber: string }) {
    this.ensureCalls.push(input);
    return { id: input.callId ?? 'call-1', tenantId: 'tenant-1', locationId: 'loc-1' };
  }
  async postEvent(_callId: string, eventType: string) {
    this.events.push(eventType);
  }
  async appendTranscript(_callId: string, turns: Array<{ speaker: 'caller' | 'agent'; text: string }>) {
    this.transcript.push(...turns);
  }
  async setRecording(_callId: string, patch: { recordingId?: string; recordingStatus: string }) {
    this.recordings.push(patch);
  }
  async completeCall(callId: string, patch?: { summary?: string | null }) {
    this.completed.push(callId);
    this.summaries.push(patch?.summary);
  }
}

// SiphonAI's internal call id is NOT a UUID — exercise that on purpose.
const CALL_ID = 'siphon-1a2b3c';

describe('Orchestrator media server (fake Siphon)', () => {
  let media: MediaServerHandle;
  let spy: SpyPersistence;
  let port: number;

  beforeAll(async () => {
    spy = new SpyPersistence();
    media = createMediaServer({ log: pino({ level: 'silent' }), persistence: spy, nodeId: 'test-node' });
    port = await media.listen(0); // ephemeral port
  });
  afterAll(async () => {
    await media.close();
  });

  function connect(): Promise<WebSocket> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    return new Promise((resolve, reject) => {
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('healthz responds on the same server', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('runs a full session: start -> frames -> barge-in -> close', async () => {
    const ws = await connect();
    const inbound: string[] = [];
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (!isBinary) inbound.push(d.toString());
    });

    // start handshake
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

    // a few audio frames (binary)
    for (let i = 0; i < 5; i++) ws.send(Buffer.alloc(320), { binary: true });

    // SiphonAI speech_started -> expect a `clear` control back (barge-in)
    const gotClear = new Promise<void>((resolve) => {
      ws.on('message', (d: Buffer, isBinary: boolean) => {
        if (!isBinary && d.toString().includes('"type":"clear"')) resolve();
      });
    });
    ws.send(JSON.stringify({ type: 'speech_started', call_id: CALL_ID, seq: 1 }));
    await gotClear;

    // SiphonAI ends the call with `stop` (then closes the socket).
    ws.send(JSON.stringify({ type: 'stop', call_id: CALL_ID, seq: 2, reason: 'caller_hangup' }));
    ws.close();
    await new Promise((r) => setTimeout(r, 50)); // let stop/onClose flush

    expect(spy.ensureCalls).toHaveLength(1);
    expect(spy.events).toContain('call.answered');
    expect(spy.events).toContain('call.media_started'); // emitted on speech_started
    expect(spy.completed).toContain('call-1'); // DB row id (siphon call_id is not a UUID)
    expect(inbound.some((m) => m.includes('"type":"clear"'))).toBe(true);
  });

  it('records the recording lifecycle SiphonAI reports (protocol §3.11)', async () => {
    const ws = await connect();
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-rec-1',
        seq: 0,
        from: '+15185551212',
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));
    const before = spy.recordings.length;

    ws.send(
      JSON.stringify({
        type: 'recording_started',
        call_id: 'siphon-rec-1',
        seq: 1,
        recording_id: 'siphon-rec-1',
      }),
    );
    ws.send(
      JSON.stringify({
        type: 'recording_stopped',
        call_id: 'siphon-rec-1',
        seq: 2,
        recording_id: 'siphon-rec-1',
      }),
    );
    await new Promise((r) => setTimeout(r, 60));

    // The id is what later correlates the `recording_uploaded` webhook to this call.
    expect(spy.recordings.slice(before)).toEqual([
      { recordingId: 'siphon-rec-1', recordingStatus: 'started' },
      { recordingId: 'siphon-rec-1', recordingStatus: 'stopped' },
    ]);
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('keeps the call alive when recording fails — it is best-effort', async () => {
    const ws = await connect();
    const inbound: string[] = [];
    ws.on('message', (d: Buffer, isBinary: boolean) => {
      if (!isBinary) inbound.push(d.toString());
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-rec-2',
        seq: 0,
        from: '+15185551212',
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );
    await new Promise((r) => setTimeout(r, 30));

    ws.send(
      JSON.stringify({
        type: 'recording_failed',
        call_id: 'siphon-rec-2',
        seq: 1,
        recording_id: 'siphon-rec-2',
        reason: 'disk full',
      }),
    );
    await new Promise((r) => setTimeout(r, 60));

    expect(spy.recordings.at(-1)).toEqual({
      recordingId: 'siphon-rec-2',
      recordingStatus: 'failed',
    });
    // Nothing was torn down over it: no hangup went out and the socket is open.
    expect(inbound.some((m) => m.includes('"type":"hangup"'))).toBe(false);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
    await new Promise((r) => setTimeout(r, 30));
  });
});
