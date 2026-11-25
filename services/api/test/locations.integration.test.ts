import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Dev-mode multi-location create/list/delete against the Docker DB.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const OWNER = `locowner-${Date.now()}@brayz.test`;

describe.skipIf(!dbUp)('Multi-location management', () => {
  let app: App;
  let tenantId: string;
  beforeAll(async () => {
    app = await buildApp();
    const t = await prisma.tenant.create({ data: { name: 'Loc Co' } });
    tenantId = t.id;
    await prisma.location.create({ data: { tenantId, name: 'First', timezone: 'America/New_York' } });
  });
  afterAll(async () => {
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const headers = () => ({ 'x-brayz-user-email': OWNER, 'x-brayz-tenant-id': tenantId });

  it('creates a second location and lists both', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: headers(),
      payload: { tenantId, name: 'Second', timezone: 'America/New_York' },
    });
    expect(res.statusCode).toBe(201);
    const list = await app.inject({ method: 'GET', url: '/v1/locations', headers: headers() });
    expect((list.json() as Array<{ name: string }>).map((l) => l.name).sort()).toEqual(['First', 'Second']);
  });

  it('deletes a location (204) and it disappears from the list', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/locations', headers: headers() });
    const second = (list.json() as Array<{ id: string; name: string }>).find((l) => l.name === 'Second')!;
    const del = await app.inject({ method: 'DELETE', url: `/v1/locations/${second.id}`, headers: headers() });
    expect(del.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/v1/locations', headers: headers() });
    expect((after.json() as Array<{ name: string }>).map((l) => l.name)).toEqual(['First']);
  });

  it('saves the profile with untouched empty fields sent as null, and clears a field with null', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/locations', headers: headers() });
    const first = (list.json() as Array<{ id: string }>)[0]!;
    // What the settings form sends for a location whose other fields were never filled in.
    const save = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${first.id}`,
      headers: headers(),
      payload: { notificationPhone: '+15185550199', escalationPhone: null, city: null, aiGreetings: [] },
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().notificationPhone).toBe('+15185550199');

    const clear = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${first.id}`,
      headers: headers(),
      payload: { notificationPhone: null },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().notificationPhone).toBeNull();

    // The required strings can't be nulled away.
    const bad = await app.inject({ method: 'PATCH', url: `/v1/locations/${first.id}`, headers: headers(), payload: { name: null } });
    expect(bad.statusCode).toBe(400);
  });

  it('blocks a staff member from deleting (403)', async () => {
    const staff = `locstaff-${Date.now()}@brayz.test`;
    const user = await prisma.user.create({ data: { email: staff, authSubject: `dev:${staff}` } });
    await prisma.userTenantMembership.create({ data: { tenantId, userId: user.id, role: 'staff' } });
    const list = await app.inject({ method: 'GET', url: '/v1/locations', headers: headers() });
    const first = (list.json() as Array<{ id: string }>)[0];
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/locations/${first.id}`,
      headers: { 'x-brayz-user-email': staff, 'x-brayz-tenant-id': tenantId },
    });
    expect(res.statusCode).toBe(403);
  });
});
