import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `messages-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

/**
 * The Messages screen's routes: what callers left, and marking one done.
 * Rows are created straight in the table here — the taking of a message
 * through the tool endpoint is covered in tools.integration.test.ts.
 */
describe.skipIf(!dbUp)('Messages', () => {
  let app: App;
  let locationId: string;
  let otherLocationId: string;
  let userId: string;
  const ids: string[] = [];
  const headers = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT, 'content-type': 'application/json' };

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const u = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = u.id;
    await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId, role: 'staff' } });
    const [a, b] = await Promise.all([
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Messages Kitchen' }, select: { id: true } }),
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Messages Kitchen B' }, select: { id: true } }),
    ]);
    locationId = a.id;
    otherLocationId = b.id;
    for (const [loc, body, status] of [
      [locationId, 'Older, already handled', 'done'],
      [locationId, 'Call back about catering', 'new'],
      [locationId, 'Left a jacket on Friday', 'new'],
      [otherLocationId, 'Belongs to the other location', 'new'],
    ] as const) {
      const m = await prisma.callMessage.create({
        data: { tenantId: SEEDED_TENANT, locationId: loc, body, status, callerName: 'Sam', callbackNumber: '+15185551000' },
        select: { id: true },
      });
      ids.push(m.id);
    }
  });

  afterAll(async () => {
    await prisma.callMessage.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    for (const id of [locationId, otherLocationId]) await prisma.location.deleteMany({ where: { id } }).catch(() => {});
    await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('lists the new ones for a location, newest first, with the waiting count', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/messages`, headers });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Array<{ body: string; status: string }>; newCount: number };
    expect(body.newCount).toBe(2);
    expect(body.messages.map((m) => m.body)).toEqual(['Left a jacket on Friday', 'Call back about catering']);
    expect(body.messages.every((m) => m.status === 'new')).toBe(true);
  });

  it('can show the done ones, or everything', async () => {
    const done = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/messages?status=done`, headers });
    expect(done.json().messages.map((m: { body: string }) => m.body)).toEqual(['Older, already handled']);
    const all = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/messages?status=all`, headers });
    expect(all.json().messages).toHaveLength(3);
    expect(all.json().newCount).toBe(2);
  });

  it('marks one done, recording who and when, and can reopen it', async () => {
    const id = ids[1]!;
    const res = await app.inject({ method: 'PATCH', url: `/v1/messages/${id}`, headers, payload: { status: 'done' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, status: 'done', doneById: userId });
    expect(res.json().doneAt).not.toBeNull();
    const list = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/messages`, headers });
    expect(list.json().newCount).toBe(1);

    const back = await app.inject({ method: 'PATCH', url: `/v1/messages/${id}`, headers, payload: { status: 'new' } });
    expect(back.json()).toMatchObject({ status: 'new', doneAt: null, doneById: null });
  });

  it('is tenant-scoped: another tenant cannot see or touch them', async () => {
    const outsider = await prisma.tenant.create({ data: { name: 'Outsider Diner' }, select: { id: true } });
    const outsiderEmail = `messages-outsider-${Date.now()}@brayz.test`;
    const u = await prisma.user.create({ data: { email: outsiderEmail, authSubject: outsiderEmail } });
    await prisma.userTenantMembership.create({ data: { tenantId: outsider.id, userId: u.id, role: 'owner' } });
    const h = { ...headers, 'x-brayz-user-email': outsiderEmail, 'x-brayz-tenant-id': outsider.id };
    const list = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/messages`, headers: h });
    expect(list.statusCode).toBe(404);
    const patch = await app.inject({ method: 'PATCH', url: `/v1/messages/${ids[2]}`, headers: h, payload: { status: 'done' } });
    expect(patch.statusCode).toBe(404);
    expect((await prisma.callMessage.findUniqueOrThrow({ where: { id: ids[2]! } })).status).toBe('new');
    await prisma.tenant.deleteMany({ where: { id: outsider.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: u.id } }).catch(() => {});
  });

  it('rejects a status it does not know', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/v1/messages/${ids[2]}`, headers, payload: { status: 'ignored' } });
    expect(res.statusCode).toBe(400);
  });
});
