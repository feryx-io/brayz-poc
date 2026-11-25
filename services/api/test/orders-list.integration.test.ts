import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `orders-list-owner-${Date.now()}@brayz.test`;
const MINUTE = 60 * 1000;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const headers = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

interface ListedOrder {
  id: string;
  code: string;
  status: string;
}

/**
 * The Orders screen once a restaurant has been open a while: the tickets still
 * owed, all of them, apart from the ones that are done, which page. Until now
 * the list was the newest hundred of everything, so completed orders piled up
 * in the working view and an old open one could fall off the end. The
 * dashboard's "Orders today" counted inside that same hundred, so it gets a
 * real count.
 */
describe.skipIf(!dbUp)('Orders list: open and done', () => {
  let app: App;
  let locationId: string;
  let otherLocationId: string;
  let userId: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildApp();
    const [location, other] = await Promise.all([
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Orders List Kitchen' } }),
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Orders List Elsewhere' } }),
    ]);
    locationId = location.id;
    otherLocationId = other.id;
    const u = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = u.id;
    await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId, role: 'owner' } });

    // Oldest first. The open call-ahead is the oldest order of all: under the
    // old newest-hundred rule it is the first thing to fall off the board.
    const now = Date.now();
    const rows: Array<[string, string, number]> = [
      ['callAhead', 'confirmed', 300],
      ['done1', 'completed', 240],
      ['canceled', 'canceled', 200],
      ['done2', 'completed', 120],
      ['making', 'accepted', 60],
      ['done3', 'completed', 30],
      ['fresh', 'confirmed', 5],
    ];
    for (const [key, status, minutesAgo] of rows) {
      const o = await prisma.order.create({
        data: {
          tenantId: SEEDED_TENANT,
          locationId,
          status,
          customerName: key,
          subtotalCents: 1000,
          totalCents: 1000,
          createdAt: new Date(now - minutesAgo * MINUTE),
        },
        select: { id: true },
      });
      ids[key] = o.id;
    }
    await prisma.order.create({
      data: { tenantId: SEEDED_TENANT, locationId: otherLocationId, status: 'confirmed', subtotalCents: 1, totalCents: 1 },
    });
  });

  afterAll(async () => {
    await prisma.location.deleteMany({ where: { id: { in: [locationId, otherLocationId].filter(Boolean) } } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  const get = (query: string) =>
    app.inject({ method: 'GET', url: `/v1/locations/${locationId}/orders${query}`, headers });

  it('open is every order still owed, newest first, and nothing finished', async () => {
    const res = await get('?status=open');
    expect(res.statusCode, res.body).toBe(200);
    const orders = res.json() as ListedOrder[];
    expect(orders.map((o) => o.id)).toEqual([ids.fresh, ids.making, ids.callAhead]);
    expect(orders.every((o) => o.code)).toBe(true);
  });

  it('closed is completed and canceled, newest first, a page at a time', async () => {
    const first = await get('?status=closed&limit=2');
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json() as { orders: ListedOrder[]; nextCursor: string | null };
    expect(page1.orders.map((o) => o.id)).toEqual([ids.done3, ids.done2]);
    expect(page1.nextCursor).toBeTruthy();

    const second = await get(`?status=closed&limit=2&cursor=${page1.nextCursor}`);
    const page2 = second.json() as { orders: ListedOrder[]; nextCursor: string | null };
    expect(page2.orders.map((o) => o.id)).toEqual([ids.canceled, ids.done1]);
    expect(page2.nextCursor).toBeNull();
  });

  it('with no status, answers as it always has', async () => {
    const res = await get('');
    expect((res.json() as ListedOrder[]).map((o) => o.id)).toEqual([
      ids.fresh, ids.done3, ids.making, ids.done2, ids.canceled, ids.done1, ids.callAhead,
    ]);
  });

  it('counts the orders taken in a range, every status, at this location only', async () => {
    const count = (from: Date, to: Date) =>
      app.inject({
        method: 'GET',
        url: `/v1/locations/${locationId}/orders/count?from=${from.toISOString()}&to=${to.toISOString()}`,
        headers,
      });
    const now = Date.now();
    // The last 2½ hours: making (60m), done3 (30m), done2 (120m), fresh (5m).
    const recent = await count(new Date(now - 150 * MINUTE), new Date(now + MINUTE));
    expect(recent.statusCode, recent.body).toBe(200);
    expect(recent.json()).toEqual({ count: 4 });
    // All seven, and not the order at the other location.
    expect((await count(new Date(now - 24 * 60 * MINUTE), new Date(now + MINUTE))).json()).toEqual({ count: 7 });
    expect((await count(new Date(now + MINUTE), new Date(now - MINUTE))).statusCode).toBe(400);
  });

  it('rejects a cursor it did not issue', async () => {
    const res = await get('?status=closed&cursor=not-a-cursor');
    expect(res.statusCode).toBe(400);
  });
});
