import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
// Set BEFORE the app/config loads — phone-number targets need it to resolve.
process.env.BRAYZ_TRANSFER_SIP_DOMAIN = 'trunk.brayz.test';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550126'; // unique per test file — orders owns 0125
const OWNER_EMAIL = `tt-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET };
const ownerHeaders = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

describe.skipIf(!dbUp)('Per-location transfer targets', () => {
  let app: App;
  let callId: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, e164Number: TEST_NUMBER },
    });
    await prisma.locationTransferTarget.deleteMany({ where: { locationId: SEEDED_LOCATION, key: 'kitchen' } });

    const call = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', toNumber: TEST_NUMBER },
    });
    callId = call.json().id;

    // An owner membership on the seeded tenant so manager-gated CRUD is allowed.
    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId, role: 'owner' },
    });
  });

  afterAll(async () => {
    await prisma.locationTransferTarget.deleteMany({ where: { locationId: SEEDED_LOCATION, key: 'kitchen' } }).catch(() => {});
    // Guard ids that may be undefined after a failed beforeAll — Prisma ignores
    // undefined where-fields, so an unguarded deleteMany would wipe the whole table.
    if (callId) await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  // ---- Voice plane (node-authed): the runtime path the bot uses ----

  it('lists transfer targets for a call, resolving phone + sip destinations to REFER URIs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/transfer-targets`,
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { targets } = res.json() as { targets: { key: string; label: string; sipUri: string }[] };
    const byKey = Object.fromEntries(targets.map((t) => [t.key, t]));
    // Phone-number destinations get the configured SIP domain...
    expect(byKey.manager.sipUri).toBe('sip:+15185550000@trunk.brayz.test');
    expect(byKey.ordering.sipUri).toBe('sip:+15185559898@trunk.brayz.test');
    // ...a full sip: URI passes through untouched.
    expect(byKey.bob.sipUri).toBe('sip:bob@pbx.example.com');
  });

  it('rejects the node endpoint without the node secret', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/transfer-targets` });
    expect(res.statusCode).toBe(401);
  });

  it('404s transfer targets for an unknown call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/calls/99999999-9999-9999-9999-999999999999/tools/transfer-targets',
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(404);
  });

  // ---- Dashboard (user-authed, manager-gated) ----

  it('creates, lists, updates, and deletes a target; rejects a duplicate key', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/locations/${SEEDED_LOCATION}/transfer-targets`,
      headers: ownerHeaders,
      payload: { key: 'kitchen', label: 'the kitchen', destination: 'sip:kitchen@pbx.example.com', sortOrder: 3 },
    });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const dup = await app.inject({
      method: 'POST',
      url: `/v1/locations/${SEEDED_LOCATION}/transfer-targets`,
      headers: ownerHeaders,
      payload: { key: 'kitchen', label: 'dupe', destination: 'sip:x@y' },
    });
    expect(dup.statusCode).toBe(409);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${SEEDED_LOCATION}/transfer-targets`,
      headers: ownerHeaders,
    });
    const keys = (list.json() as { key: string }[]).map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(['manager', 'ordering', 'bob', 'kitchen']));

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/transfer-targets/${id}`,
      headers: ownerHeaders,
      payload: { label: 'Kitchen line' },
    });
    expect(patch.json().label).toBe('Kitchen line');

    const del = await app.inject({ method: 'DELETE', url: `/v1/transfer-targets/${id}`, headers: ownerHeaders });
    expect(del.statusCode).toBe(204);
  });
});
