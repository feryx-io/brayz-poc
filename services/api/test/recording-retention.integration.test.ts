import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingLocation, RecordingStorage } from '../src/lib/recordingStorage.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.RECORDING_MAX_RETENTION_DAYS = '90';
// OIDC is only accepted with both of these set; the tests below exercise it
// with a fake verifier.
process.env.SCHEDULER_INVOKER_EMAIL = 'sweeper@brayz-test.iam.gserviceaccount.com';
process.env.SCHEDULER_OIDC_AUDIENCE = 'brayz-test-api';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const OWNER_EMAIL = `retention-owner-${Date.now()}@brayz.test`;
// Unique per test file — retention owns 0143.
const TEST_NUMBER = '+15185550143';
const BUCKET = 'brayz-test-call-recordings';
const DAY_MS = 24 * 60 * 60 * 1000;

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
const ownerHeaders = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
};

/**
 * A store that remembers what it was asked to delete, and can be told to
 * answer "missing" or refuse for a given key — the three outcomes the sweep
 * has to handle differently.
 */
class FakeStorage implements RecordingStorage {
  readonly name = 'fake';
  readonly deleted: string[] = [];
  readonly missing = new Set<string>();
  readonly refuse = new Set<string>();
  signedUrl(loc: RecordingLocation): string {
    return `https://fake/${loc.bucket}/${loc.key}`;
  }
  async delete(loc: RecordingLocation): Promise<'deleted' | 'missing'> {
    if (this.refuse.has(loc.key)) throw new Error('store says no');
    this.deleted.push(loc.key);
    return this.missing.has(loc.key) ? 'missing' : 'deleted';
  }
}

describe.skipIf(!dbUp)('recording retention', () => {
  let app: App;
  let storage: FakeStorage;
  let ownerUserId: string | undefined;
  /** The location with a 30-day policy. */
  let locationId: string;
  /** A sibling location with no policy — its recordings must be untouched. */
  let unmanagedLocationId: string;
  const callIds: string[] = [];
  const oidcTokens = new Map<string, { email: string; emailVerified: boolean; audience?: string }>();

  /** A finished call with an uploaded recording, started `ageDays` ago. */
  async function recordedCall(loc: string, ageDays: number, key: string): Promise<string> {
    const startedAt = new Date(Date.now() - ageDays * DAY_MS);
    const call = await prisma.call.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId: loc,
        provider: 'twilio',
        fromNumber: '+15185551717',
        toNumber: TEST_NUMBER,
        status: 'completed',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 90_000),
        recordingStatus: 'uploaded',
        recordingId: `siphon-${key}`,
        recordingUrl: `s3://${BUCKET}/${key}`,
      },
      select: { id: true },
    });
    callIds.push(call.id);
    return call.id;
  }

  // No body, so no content-type: Fastify rejects a JSON content-type with an
  // empty body before any handler runs, and the scheduler sends neither.
  const sweep = (headers: Record<string, string> = nodeHeaders) => {
    const { 'content-type': _omitted, ...rest } = headers;
    return app.inject({ method: 'POST', url: '/v1/internal/recordings/sweep', headers: rest });
  };

  const callRow = (id: string) =>
    prisma.call.findUniqueOrThrow({
      where: { id },
      select: { recordingStatus: true, recordingUrl: true },
    });

  beforeAll(async () => {
    storage = new FakeStorage();
    app = await buildApp({
      notifier: null,
      recordingStorage: storage,
      schedulerOidcVerifier: {
        async verify(token, audience) {
          const t = oidcTokens.get(token);
          if (!t) throw new Error('bad token');
          if (t.audience && t.audience !== audience) throw new Error('wrong audience');
          return { email: t.email, emailVerified: t.emailVerified };
        },
      },
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const [managed, unmanaged] = await Promise.all([
      prisma.location.create({
        data: { tenantId: SEEDED_TENANT, name: 'Retention Test Kitchen' },
        select: { id: true },
      }),
      prisma.location.create({
        data: { tenantId: SEEDED_TENANT, name: 'Retention Test Kitchen (no policy)' },
        select: { id: true },
      }),
    ]);
    locationId = managed.id;
    unmanagedLocationId = unmanaged.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
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
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    for (const id of [locationId, unmanagedLocationId]) {
      if (id) await prisma.location.deleteMany({ where: { id } }).catch(() => {});
    }
    if (ownerUserId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: ownerUserId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: ownerUserId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  // ---- The setting ----

  it('reports no policy and the platform ceiling by default', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recordingRetentionDays).toBeNull();
    expect(res.json().recordingRetentionMaxDays).toBe(90);
  });

  it('refuses a retention longer than the platform keeps recordings', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { recordingRetentionDays: 91 },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('retention_above_ceiling');
  });

  it('refuses zero and negative retention', async () => {
    for (const bad of [0, -1, 1.5]) {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/locations/${locationId}/ai-settings`,
        headers: ownerHeaders,
        payload: { recordingRetentionDays: bad },
      });
      expect(res.statusCode, String(bad)).toBe(400);
    }
  });

  it('saves a 30-day policy and echoes the ceiling', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { recordingRetentionDays: 30 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recordingRetentionDays).toBe(30);
    expect(res.json().recordingRetentionMaxDays).toBe(90);
  });

  // ---- The trigger's authentication ----

  it('refuses an unauthenticated sweep', async () => {
    const res = await sweep({});
    expect(res.statusCode).toBe(401);
  });

  it('refuses a dashboard user — the sweep is not a tenant action', async () => {
    const res = await sweep(ownerHeaders);
    expect(res.statusCode).toBe(401);
  });

  it('refuses an OIDC token for a different service account', async () => {
    oidcTokens.set('tok-impostor', {
      email: 'someone-else@brayz-test.iam.gserviceaccount.com',
      emailVerified: true,
    });
    const res = await sweep({ authorization: 'Bearer tok-impostor' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an OIDC token whose email is not verified', async () => {
    oidcTokens.set('tok-unverified', {
      email: 'sweeper@brayz-test.iam.gserviceaccount.com',
      emailVerified: false,
    });
    const res = await sweep({ authorization: 'Bearer tok-unverified' });
    expect(res.statusCode).toBe(401);
  });

  it('refuses an OIDC token minted for another audience', async () => {
    oidcTokens.set('tok-wrong-aud', {
      email: 'sweeper@brayz-test.iam.gserviceaccount.com',
      emailVerified: true,
      audience: 'some-other-service',
    });
    const res = await sweep({ authorization: 'Bearer tok-wrong-aud' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the scheduler service account by OIDC token', async () => {
    oidcTokens.set('tok-scheduler', {
      email: 'sweeper@brayz-test.iam.gserviceaccount.com',
      emailVerified: true,
      audience: 'brayz-test-api',
    });
    const res = await sweep({ authorization: 'Bearer tok-scheduler' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ locations: 1 });
  });

  // ---- The sweep ----

  it('deletes only recordings past their location policy', async () => {
    const expired = await recordedCall(locationId, 31, '2026-08-04/siphon-expired');
    const recent = await recordedCall(locationId, 29, '2026-08-06/siphon-recent');
    // Same age as `expired`, but its location has no policy — the platform
    // ceiling (90 days) is the only thing that applies to it.
    const unmanaged = await recordedCall(unmanagedLocationId, 31, '2026-08-04/siphon-unmanaged');

    const res = await sweep();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ locations: 1, scanned: 1, deleted: 1, failed: 0 });
    expect(storage.deleted).toEqual(['2026-08-04/siphon-expired']);

    expect(await callRow(expired)).toEqual({ recordingStatus: 'deleted', recordingUrl: null });
    expect(await callRow(recent)).toMatchObject({ recordingStatus: 'uploaded' });
    expect(await callRow(unmanaged)).toMatchObject({ recordingStatus: 'uploaded' });

    // Rule #6: the deletion is on the record, against the call, with why.
    const audit = await prisma.auditLog.findFirst({
      where: { targetId: expired, action: 'recording.deleted' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.tenantId).toBe(SEEDED_TENANT);
    expect(audit?.locationId).toBe(locationId);
    expect(audit?.metadata).toMatchObject({ reason: 'retention', retentionDays: 30, object: 'deleted' });
  });

  it('is idempotent: a second run finds nothing', async () => {
    const before = storage.deleted.length;
    const res = await sweep();
    expect(res.json()).toEqual({ locations: 1, scanned: 0, deleted: 0, failed: 0 });
    expect(storage.deleted.length).toBe(before);
  });

  it('treats an object the bucket already removed as done', async () => {
    const gone = await recordedCall(locationId, 40, '2026-07-26/siphon-gone');
    storage.missing.add('2026-07-26/siphon-gone');

    const res = await sweep();
    expect(res.json()).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
    expect(await callRow(gone)).toEqual({ recordingStatus: 'deleted', recordingUrl: null });
    const audit = await prisma.auditLog.findFirst({
      where: { targetId: gone, action: 'recording.deleted' },
    });
    expect(audit?.metadata).toMatchObject({ object: 'missing' });
  });

  it('leaves a call for the next run when the store refuses', async () => {
    const stuck = await recordedCall(locationId, 45, '2026-07-21/siphon-stuck');
    storage.refuse.add('2026-07-21/siphon-stuck');

    let res = await sweep();
    expect(res.json()).toMatchObject({ scanned: 1, deleted: 0, failed: 1 });
    // The row still says the recording is there, because it is.
    expect(await callRow(stuck)).toMatchObject({
      recordingStatus: 'uploaded',
      recordingUrl: `s3://${BUCKET}/2026-07-21/siphon-stuck`,
    });
    expect(
      await prisma.auditLog.count({ where: { targetId: stuck, action: 'recording.deleted' } }),
    ).toBe(0);

    // The store recovers; the next run finishes the job.
    storage.refuse.delete('2026-07-21/siphon-stuck');
    res = await sweep();
    expect(res.json()).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
    expect(await callRow(stuck)).toEqual({ recordingStatus: 'deleted', recordingUrl: null });
  });

  it('never deletes a recording that was not uploaded', async () => {
    // Recorded on the node but never confirmed in storage: there is no object
    // we know of to delete, and clearing the row would erase the only trace.
    const startedAt = new Date(Date.now() - 60 * DAY_MS);
    const call = await prisma.call.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        provider: 'twilio',
        status: 'completed',
        startedAt,
        recordingStatus: 'failed',
        recordingId: 'siphon-never-uploaded',
      },
      select: { id: true },
    });
    callIds.push(call.id);
    const before = storage.deleted.length;
    const res = await sweep();
    expect(res.json()).toMatchObject({ scanned: 0, deleted: 0 });
    expect(storage.deleted.length).toBe(before);
    expect(await callRow(call.id)).toMatchObject({ recordingStatus: 'failed' });
  });

  it('turning the policy off leaves remaining recordings alone', async () => {
    const kept = await recordedCall(locationId, 50, '2026-07-16/siphon-kept');
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { recordingRetentionDays: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().recordingRetentionDays).toBeNull();

    const run = await sweep();
    expect(run.json()).toEqual({ locations: 0, scanned: 0, deleted: 0, failed: 0 });
    expect(await callRow(kept)).toMatchObject({ recordingStatus: 'uploaded' });
  });

  it('a deleted recording is gone from the playback route too', async () => {
    const expired = callIds[0]!;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${expired}/recording`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('recording_unavailable');
  });
});
