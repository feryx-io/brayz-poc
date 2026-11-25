import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550130';
const CALLER = '+15185557777';

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
const userHeaders = { 'x-brayz-user-email': 'guests-owner@brayz.test', 'x-brayz-tenant-id': SEEDED_TENANT };

describe.skipIf(!dbUp)('Guest memory (linkage + tools + CRUD + audit)', () => {
  let app: App;
  let callId: string;
  let guestId: string | undefined;

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: CALLER, toNumber: TEST_NUMBER },
    });
    return res.json().id;
  }

  beforeAll(async () => {
    app = await buildApp();
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, e164Number: TEST_NUMBER },
    });
    callId = await newCall();
  });

  afterAll(async () => {
    if (guestId) {
      await prisma.auditLog.deleteMany({ where: { targetId: guestId } }).catch(() => {});
      await prisma.guest.deleteMany({ where: { id: guestId } }).catch(() => {});
    }
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } }).catch(() => {});
    await prisma.call.deleteMany({ where: { toNumber: TEST_NUMBER } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    await prisma.locationAiSettings
      .updateMany({ where: { locationId: SEEDED_LOCATION }, data: { guestMemoryMode: 'full' } })
      .catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('save_guest_memory creates + links a guest for a new caller (audited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/guest/memory`,
      headers: nodeHeaders,
      payload: { name: 'Mike', note: 'allergic to nuts' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saved: true });

    const gpn = await prisma.guestPhoneNumber.findUnique({
      where: { tenantId_e164: { tenantId: SEEDED_TENANT, e164: CALLER } },
      select: { guestId: true },
    });
    expect(gpn).toBeTruthy();
    guestId = gpn!.guestId;

    const guest = await prisma.guest.findUnique({ where: { id: guestId } });
    expect(guest?.displayName).toBe('Mike');
    expect(guest?.notes).toContain('allergic to nuts');

    const call = await prisma.call.findUnique({ where: { id: callId }, select: { guestId: true } });
    expect(call?.guestId).toBe(guestId); // the call was back-linked

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: guestId, action: 'guest.memory.updated' },
    });
    expect(audit).toBeTruthy();
  });

  it('recognizes the returning caller on the next call', async () => {
    const id = await newCall();
    const call = await prisma.call.findUnique({ where: { id }, select: { guestId: true } });
    expect(call?.guestId).toBe(guestId);
  });

  it('guest tool reports a returning guest; details expose saved notes', async () => {
    const g = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/guest`, headers: nodeHeaders });
    expect(g.json()).toMatchObject({ isReturning: true, displayName: 'Mike', mode: 'full' });

    const d = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/guest/details`, headers: nodeHeaders });
    expect(d.statusCode).toBe(200);
    expect((d.json() as { notes?: string }).notes).toContain('allergic to nuts');
  });

  it('off mode withholds personalization (code-enforced)', async () => {
    await prisma.locationAiSettings.upsert({
      where: { locationId: SEEDED_LOCATION },
      update: { guestMemoryMode: 'off' },
      create: { locationId: SEEDED_LOCATION, guestMemoryMode: 'off' },
    });
    const g = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/guest`, headers: nodeHeaders });
    expect(g.json()).toMatchObject({ isReturning: false, mode: 'off' });
    const d = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/guest/details`, headers: nodeHeaders });
    expect(d.statusCode).toBe(403);
    await prisma.locationAiSettings.update({
      where: { locationId: SEEDED_LOCATION },
      data: { guestMemoryMode: 'full' },
    });
  });

  it('per-guest opt-out blocks personalization and audits the consent change', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/guests/${guestId}`,
      headers: { ...userHeaders, 'content-type': 'application/json' },
      payload: { memoryEnabled: false },
    });
    expect(patch.statusCode).toBe(200);

    const g = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/guest`, headers: nodeHeaders });
    expect((g.json() as { isReturning: boolean }).isReturning).toBe(false);

    const consent = await prisma.auditLog.findFirst({
      where: { targetId: guestId, action: 'consent.changed' },
    });
    expect(consent).toBeTruthy();

    // Re-enable for the remaining read tests.
    await app.inject({
      method: 'PATCH',
      url: `/v1/guests/${guestId}`,
      headers: { ...userHeaders, 'content-type': 'application/json' },
      payload: { memoryEnabled: true },
    });
  });

  it('lists guests and reads a profile (audited access)', async () => {
    const list = await app.inject({ method: 'GET', url: `/v1/locations/${SEEDED_LOCATION}/guests`, headers: userHeaders });
    expect(list.statusCode).toBe(200);
    const guests = list.json() as Array<{ id: string; displayName: string }>;
    expect(guests.some((g) => g.id === guestId)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/v1/guests/${guestId}`, headers: userHeaders });
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { displayName: string }).displayName).toBe('Mike');

    const access = await prisma.auditLog.findFirst({
      where: { targetId: guestId, action: 'guest_profile.accessed' },
    });
    expect(access).toBeTruthy();
  });

  it('deletes a guest (right-to-be-forgotten, audited)', async () => {
    const del = await app.inject({ method: 'DELETE', url: `/v1/guests/${guestId}`, headers: userHeaders });
    expect(del.statusCode).toBe(204);
    const gone = await prisma.guest.findUnique({ where: { id: guestId } });
    expect(gone).toBeNull();
    const audit = await prisma.auditLog.findFirst({ where: { targetId: guestId, action: 'guest.deleted' } });
    expect(audit).toBeTruthy();
  });
});
