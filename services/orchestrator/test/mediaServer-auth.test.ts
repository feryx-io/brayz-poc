import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import { createMediaServer, type MediaServerHandle } from '../src/mediaServer.js';
import type { CallPersistence } from '../src/persistence.js';

/**
 * /v1/media is the door into a call: whoever gets through it can make the bot
 * talk, on our model and speech spend, and can create call records. The
 * deployed service is invokable by allUsers, so the bearer check is the only
 * thing between the public internet and that.
 */
const silent = pino({ level: 'silent' });

const persistence: CallPersistence = {
  async ensureCall(input: { callId?: string; toNumber: string }) {
    return { id: input.callId ?? 'call-1', tenantId: 't1', locationId: 'l1' };
  },
  async postEvent() {},
  async appendTranscript() {},
  async setRecording() {},
  async completeCall() {},
};

const SECRET = 'node-secret-under-test';

let media: MediaServerHandle | undefined;
afterEach(async () => {
  await media?.close();
  media = undefined;
});

/** Resolves to 'open', or the HTTP status the upgrade was refused with. */
function connect(port: number, headers?: Record<string, string>): Promise<string | number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`, 'siphon-ai.v1', { headers });
    ws.on('open', () => {
      ws.close();
      resolve('open');
    });
    // ws surfaces a refused upgrade as `unexpected-response` before `error`.
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('error', () => resolve('error'));
  });
}

describe('Media server authentication', () => {
  it('refuses a connection with no Authorization header', async () => {
    media = createMediaServer({ log: silent, persistence, nodeId: 'n', authToken: SECRET });
    const port = await media.listen(0);

    // 401 at the upgrade, so no WebSocket is ever created and the `start`
    // handshake — which is what persists a call — is unreachable.
    await expect(connect(port)).resolves.toBe(401);
  });

  it('refuses a wrong token, and a bare token without the Bearer scheme', async () => {
    media = createMediaServer({ log: silent, persistence, nodeId: 'n', authToken: SECRET });
    const port = await media.listen(0);

    await expect(connect(port, { authorization: 'Bearer wrong-secret' })).resolves.toBe(401);
    await expect(connect(port, { authorization: SECRET })).resolves.toBe(401);
    // A prefix of the real secret must not pass on length alone.
    await expect(connect(port, { authorization: `Bearer ${SECRET.slice(0, 5)}` })).resolves.toBe(401);
  });

  it('accepts the configured bearer token', async () => {
    media = createMediaServer({ log: silent, persistence, nodeId: 'n', authToken: SECRET });
    const port = await media.listen(0);

    await expect(connect(port, { authorization: `Bearer ${SECRET}` })).resolves.toBe('open');
  });

  it('accepts anything when no token is configured, for the loopback lab', async () => {
    media = createMediaServer({ log: silent, persistence, nodeId: 'n' });
    const port = await media.listen(0);

    await expect(connect(port)).resolves.toBe('open');
  });
});
