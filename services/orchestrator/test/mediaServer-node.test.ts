import type { IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import { createMediaServer, nodeIdFor, type MediaServerHandle } from '../src/mediaServer.js';
import type { CallPersistence } from '../src/persistence.js';

/**
 * Which SiphonAI node a call came from. SiphonAI's `start` does not say, so
 * each node names itself on the URL it dials and the Orchestrator carries that
 * onto the call record — the staff portal counts live calls per node from it.
 */
class SpyPersistence implements CallPersistence {
  ensureCalls: Array<{ nodeId?: string }> = [];
  async ensureCall(input: { callId?: string; nodeId?: string }) {
    this.ensureCalls.push(input);
    return { id: 'call-1', tenantId: 't', locationId: 'l' };
  }
  async postEvent() {}
  async appendTranscript() {}
  async setRecording() {}
  async completeCall() {}
}

const req = (url: string, headers: Record<string, string> = {}) =>
  ({ url, headers }) as unknown as IncomingMessage;

describe('nodeIdFor', () => {
  it('takes the node the URL names', () => {
    expect(nodeIdFor(req('/v1/media?node=brayz-dev-siphon-001'))).toBe('brayz-dev-siphon-001');
  });

  it('falls back to the forwarded client address', () => {
    expect(nodeIdFor(req('/v1/media', { 'x-forwarded-for': '203.0.113.190, 10.0.0.1' }))).toBe(
      'ip:203.0.113.190',
    );
  });

  it('ignores a name that is not a plain id rather than storing it', () => {
    expect(nodeIdFor(req('/v1/media?node=../x%20y', { 'x-forwarded-for': '203.0.113.190' }))).toBe(
      'ip:203.0.113.190',
    );
    expect(nodeIdFor(req('/v1/media?node=<script>'))).toBeUndefined();
  });

  it('says nothing when nothing identifies the node', () => {
    expect(nodeIdFor(req('/v1/media'))).toBeUndefined();
  });
});

describe('media server — node attribution', () => {
  let media: MediaServerHandle | undefined;
  afterEach(async () => {
    await media?.close();
    media = undefined;
  });

  async function startCall(path: string, fallback?: string): Promise<SpyPersistence> {
    const spy = new SpyPersistence();
    media = createMediaServer({ log: pino({ level: 'silent' }), persistence: spy, nodeId: fallback });
    const port = await media.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-node-test',
        seq: 0,
        from: '+15555550100',
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
        sip: { call_id: 'abc@example.com', headers: {} },
      }),
    );
    const deadline = Date.now() + 1500;
    while (spy.ensureCalls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    ws.close();
    return spy;
  }

  it('records the node the connection named on the call', async () => {
    const spy = await startCall('/v1/media?node=brayz-dev-siphon-002', 'fallback');
    expect(spy.ensureCalls[0]?.nodeId).toBe('brayz-dev-siphon-002');
  });

  it('uses the configured fallback only when the connection says nothing', async () => {
    const spy = await startCall('/v1/media', 'fallback');
    expect(spy.ensureCalls[0]?.nodeId).toBe('fallback');
  });

  it('leaves the call unattributed rather than inventing a node', async () => {
    const spy = await startCall('/v1/media');
    expect(spy.ensureCalls).toHaveLength(1);
    expect(spy.ensureCalls[0]?.nodeId).toBeUndefined();
  });
});
