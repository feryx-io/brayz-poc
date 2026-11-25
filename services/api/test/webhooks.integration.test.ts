import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const WEBHOOK_SECRET = 'a-test-webhook-secret-long-enough';
const OWNER_EMAIL = `webhook-owner-${Date.now()}@brayz.test`;
// Unique per test file — webhooks owns 0132, and its own location.
const TEST_NUMBER = '+15185550132';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET, 'content-type': 'application/json' };

/** Sign a body the way SiphonAI does: HMAC-SHA256 over `"<unix>.<raw-body>"`. */
function sign(raw: string, secret = WEBHOOK_SECRET, atMs = Date.now()) {
  const t = Math.floor(atMs / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

let eventSeq = 0;
const nextEventId = () => `11111111-2222-3333-4444-${String(++eventSeq).padStart(12, '0')}`;

describe.skipIf(!dbUp)('SiphonAI lifecycle webhooks', () => {
  let app: App;
  let unconfiguredApp: App;
  let locationId: string;
  let ownerUserId: string | undefined;
  const callIds: string[] = [];

  /** A call the way the Orchestrator creates one, with its recording id set. */
  async function newCall(recordingId: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551333', toNumber: TEST_NUMBER },
    });
    const id = res.json().id as string;
    callIds.push(id);
    await app.inject({
      method: 'PATCH',
      url: `/v1/calls/${id}`,
      headers: nodeHeaders,
      payload: { recordingId, recordingStatus: 'stopped' },
    });
    return id;
  }

  /** POST a lifecycle delivery with whatever headers the test wants to vary. */
  function deliver(
    body: Record<string, unknown>,
    opts: { signature?: string | null; eventId?: string | null; target?: App } = {},
  ) {
    const raw = JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const signature = opts.signature === undefined ? sign(raw) : opts.signature;
    if (signature) headers['x-siphonai-signature'] = signature;
    const eventId = opts.eventId === undefined ? nextEventId() : opts.eventId;
    if (eventId) headers['x-siphonai-event-id'] = eventId;
    return (opts.target ?? app).inject({
      method: 'POST',
      url: '/v1/webhooks/siphon',
      headers,
      payload: raw,
    });
  }

  beforeAll(async () => {
    app = await buildApp({ notifier: null, siphonWebhookSecret: WEBHOOK_SECRET });
    unconfiguredApp = await buildApp({ notifier: null, siphonWebhookSecret: undefined });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Webhook Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    ownerUserId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    for (const id of callIds) {
      await prisma.auditLog.deleteMany({ where: { targetId: id } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.webhookDelivery.deleteMany({ where: { source: 'siphon' } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (ownerUserId) {
      await prisma.userTenantMembership
        .deleteMany({ where: { userId: ownerUserId } })
        .catch(() => {});
      await prisma.user.deleteMany({ where: { id: ownerUserId } }).catch(() => {});
    }
    await app.close();
    await unconfiguredApp.close();
    await prisma.$disconnect();
  });

  it('refuses an unsigned delivery', async () => {
    const res = await deliver({ type: 'call_start', call_id: 'siphon-x' }, { signature: null });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('bad_signature');
  });

  it('refuses a delivery signed with the wrong secret', async () => {
    const body = { type: 'call_start', call_id: 'siphon-x' };
    const res = await deliver(body, {
      signature: sign(JSON.stringify(body), 'not-the-secret-at-all'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a signature whose body has been altered', async () => {
    const signed = sign(JSON.stringify({ type: 'call_start', call_id: 'siphon-x' }));
    // Same signature, different body — this is the attack the HMAC exists for.
    const res = await deliver(
      { type: 'call_start', call_id: 'siphon-TAMPERED' },
      { signature: signed },
    );
    expect(res.statusCode).toBe(401);
  });

  it('refuses a captured delivery replayed later', async () => {
    const body = { type: 'call_start', call_id: 'siphon-x' };
    const raw = JSON.stringify(body);
    // Signed an hour ago: valid HMAC, outside the freshness window.
    const res = await deliver(body, {
      signature: sign(raw, WEBHOOK_SECRET, Date.now() - 3_600_000),
    });
    expect(res.statusCode).toBe(401);
  });

  it('refuses everything when no secret is configured', async () => {
    const res = await deliver({ type: 'call_start' }, { target: unconfiguredApp });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('webhook_not_configured');
  });

  it('rejects a delivery with no id to dedupe on', async () => {
    const res = await deliver({ type: 'call_start', call_id: 'siphon-x' }, { eventId: null });
    expect(res.statusCode).toBe(400);
  });

  it('stamps the recording URL onto the call and audits it', async () => {
    const callId = await newCall('siphon-rec-100');
    const res = await deliver({
      type: 'recording_uploaded',
      version: 1,
      call_id: 'siphon-rec-100',
      recording_id: 'siphon-rec-100',
      url: 's3://call-recordings/2026-08-27/siphon-rec-100',
      size_bytes: 918_272,
    });
    expect(res.statusCode).toBe(200);

    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call).toMatchObject({
      recordingUrl: 's3://call-recordings/2026-08-27/siphon-rec-100',
      recordingStatus: 'uploaded',
      recordingId: 'siphon-rec-100',
    });

    // Rule #6 — a recording becoming reachable is auditable in its own right.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'recording.stored', targetId: callId },
    });
    expect(audit).toBeTruthy();
    expect(audit?.tenantId).toBe(SEEDED_TENANT);
  });

  it('ignores a redelivery of an id it already processed', async () => {
    const callId = await newCall('siphon-rec-200');
    const body = {
      type: 'recording_uploaded',
      version: 1,
      call_id: 'siphon-rec-200',
      recording_id: 'siphon-rec-200',
      url: 's3://call-recordings/first',
      size_bytes: 1,
    };
    const eventId = nextEventId();
    expect((await deliver(body, { eventId })).statusCode).toBe(200);

    // SiphonAI replays its spool after a restart with the same delivery id. The
    // second one must not re-apply — here it would overwrite a good URL.
    const replay = await deliver({ ...body, url: 's3://call-recordings/second' }, { eventId });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().duplicate).toBe(true);

    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.recordingUrl).toBe('s3://call-recordings/first');
    expect(
      await prisma.auditLog.count({ where: { action: 'recording.stored', targetId: callId } }),
    ).toBe(1);
  });

  it('falls back to the SIP-side call id when no recording id was captured', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: {
        provider: 'twilio',
        fromNumber: '+15185551333',
        toNumber: TEST_NUMBER,
        providerCallId: 'siphon-rec-300',
      },
    });
    const callId = create.json().id as string;
    callIds.push(callId);

    const res = await deliver({
      type: 'recording_uploaded',
      version: 1,
      call_id: 'siphon-rec-300',
      url: 's3://call-recordings/by-provider-id',
    });
    expect(res.statusCode).toBe(200);
    const call = await prisma.call.findUnique({ where: { id: callId } });
    expect(call?.recordingUrl).toBe('s3://call-recordings/by-provider-id');
  });

  it('acknowledges an event it does not consume without touching anything', async () => {
    const res = await deliver({ type: 'call_start', version: 1, call_id: 'siphon-unrelated' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('requests a retry for a recent recording upload whose call is not available yet', async () => {
    const res = await deliver({
      type: 'recording_uploaded',
      version: 1,
      call_id: 'siphon-never-existed',
      timestamp: new Date().toISOString(),
      recording_id: 'siphon-never-existed',
      url: 's3://call-recordings/orphan',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('recording_call_pending');
  });

  it('lets go of an upload whose call has not appeared long after the upload', async () => {
    // Retrying it forever would only fill SiphonAI's capped spool.
    for (const timestamp of [new Date(Date.now() - 60 * 60 * 1000).toISOString(), undefined]) {
      const res = await deliver({
        type: 'recording_uploaded',
        version: 1,
        call_id: 'siphon-never-existed',
        timestamp,
        recording_id: 'siphon-never-existed',
        url: 's3://call-recordings/orphan',
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('leaves the rest of the API on the normal JSON parser', async () => {
    // The webhook plugin swaps in a raw-body parser; that must stay scoped to it.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551333', toNumber: TEST_NUMBER },
    });
    expect(res.statusCode).toBe(201);
    callIds.push(res.json().id);
  });

  it('keeps the recording location out of plain call reads', async () => {
    const callId = await newCall('siphon-rec-400');
    await deliver({
      type: 'recording_uploaded',
      version: 1,
      call_id: 'siphon-rec-400',
      recording_id: 'siphon-rec-400',
      url: 's3://call-recordings/private',
    });

    const ownerHeaders = {
      'x-brayz-user-email': OWNER_EMAIL,
      'x-brayz-tenant-id': SEEDED_TENANT,
    };
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}`,
      headers: ownerHeaders,
    });
    expect(detail.statusCode).toBe(200);
    // Status yes, location no — the location is audited access (rule #6).
    expect(detail.json().recordingStatus).toBe('uploaded');
    expect(detail.payload).not.toContain('s3://call-recordings/private');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls`,
      headers: ownerHeaders,
    });
    expect(list.payload).not.toContain('s3://call-recordings/private');

    // The dedicated route serves it, and says so in the audit log.
    const reveal = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers: ownerHeaders,
    });
    expect(reveal.statusCode).toBe(200);
    expect(reveal.json().url).toBe('s3://call-recordings/private');
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'recording.accessed', targetId: callId },
    });
    expect(audit).toBeTruthy();
  });

  it('404s the recording route for a call that has none', async () => {
    const callId = await newCall('siphon-rec-500');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('recording_unavailable');
  });
});
