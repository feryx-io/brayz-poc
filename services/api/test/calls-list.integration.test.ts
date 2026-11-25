import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `calls-owner-${Date.now()}@brayz.test`;
const STAFF_EMAIL = `calls-staff-${Date.now()}@brayz.test`;
// Unique per test file — the calls list owns 0145.
const TEST_NUMBER = '+15185550145';
const HOUR = 60 * 60 * 1000;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const headersFor = (email: string) => ({
  'x-brayz-user-email': email,
  'x-brayz-tenant-id': SEEDED_TENANT,
});

/**
 * The Calls screen's list, once a restaurant has more calls than fit on one
 * screen: a time range, keyset paging inside it, per-day counts in the
 * restaurant's own timezone, and an audited CSV of a range.
 */
describe.skipIf(!dbUp)('Calls list: range, paging, days, export', () => {
  let app: App;
  let locationId: string;
  let otherLocationId: string;
  const userIds: string[] = [];
  const callIds: string[] = [];
  const orderIds: string[] = [];

  // Fixed instants, so the day boundaries under test are known. 2026-08-10
  // 03:30 UTC is 2026-08-09 23:30 in New York: the same call lands on
  // different days depending on the clock it is read by.
  const T = {
    aug9NightNY: new Date('2026-08-10T03:30:00Z'),
    aug10Morning: new Date('2026-08-10T14:00:00Z'),
    aug10Noon: new Date('2026-08-10T16:00:00Z'),
    aug10NoonAgain: new Date('2026-08-10T16:00:00Z'),
    aug11: new Date('2026-08-11T15:00:00Z'),
  };

  async function call(loc: string, startedAt: Date, extra: Record<string, unknown> = {}) {
    const c = await prisma.call.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId: loc,
        provider: 'twilio',
        fromNumber: '+15185551335',
        toNumber: TEST_NUMBER,
        status: 'completed',
        startedAt,
        endedAt: new Date(startedAt.getTime() + 95_000),
        ...extra,
      },
      select: { id: true },
    });
    callIds.push(c.id);
    return c.id;
  }

  const list = (query: string, email = OWNER_EMAIL) =>
    app.inject({ method: 'GET', url: `/v1/locations/${locationId}/calls${query}`, headers: headersFor(email) });

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const [a, b] = await Promise.all([
      prisma.location.create({
        data: { tenantId: SEEDED_TENANT, name: 'Calls List Kitchen', timezone: 'America/New_York' },
        select: { id: true },
      }),
      prisma.location.create({
        data: { tenantId: SEEDED_TENANT, name: 'Calls List Kitchen B' },
        select: { id: true },
      }),
    ]);
    locationId = a.id;
    otherLocationId = b.id;
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [STAFF_EMAIL, 'staff'],
    ] as const) {
      const u = await prisma.user.create({ data: { email, authSubject: email } });
      userIds.push(u.id);
      await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId: u.id, role } });
    }

    await call(locationId, T.aug9NightNY, { summary: 'Late one, "quoted" summary' });
    const withOrder = await call(locationId, T.aug10Morning);
    await call(locationId, T.aug10Noon, { status: 'transferred' });
    await call(locationId, T.aug10NoonAgain, { status: 'failed', endedAt: null });
    await call(locationId, T.aug11);
    // A call at the other location must never show up here (rule #1).
    await call(otherLocationId, T.aug10Noon);

    const o = await prisma.order.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        callId: withOrder,
        status: 'confirmed',
        customerName: 'Jim',
        subtotalCents: 2200,
        totalCents: 2200,
      },
      select: { id: true },
    });
    orderIds.push(o.id);
  });

  afterAll(async () => {
    for (const id of orderIds) await prisma.order.deleteMany({ where: { id } }).catch(() => {});
    for (const id of callIds) await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { action: 'calls.exported', targetId: locationId } }).catch(() => {});
    for (const id of [locationId, otherLocationId]) {
      await prisma.location.deleteMany({ where: { id } }).catch(() => {});
    }
    for (const id of userIds) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('lists newest first, in a page with a cursor', async () => {
    const res = await list('');
    expect(res.statusCode).toBe(200);
    const body = res.json() as { calls: Array<{ startedAt: string }>; nextCursor: string | null };
    expect(body.calls).toHaveLength(5);
    expect(body.nextCursor).toBeNull();
    const times = body.calls.map((c) => new Date(c.startedAt).getTime());
    expect(times).toEqual([...times].sort((x, y) => y - x));
    expect(res.payload).not.toContain('recordingUrl');
  });

  it('pages without repeating or skipping, even across two calls at the same instant', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const res = await list(`?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { calls: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.calls.map((c) => c.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('rejects a cursor it did not mint', async () => {
    const res = await list('?cursor=not-a-cursor');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_cursor');
  });

  it('narrows to a time range', async () => {
    const res = await list(`?from=${T.aug10Morning.toISOString()}&to=${T.aug11.toISOString()}`);
    const body = res.json() as { calls: Array<{ startedAt: string }> };
    // from is inclusive, to is exclusive: the three on the 10th, not the 11th.
    expect(body.calls).toHaveLength(3);
  });

  it('counts each day in the restaurant’s timezone, not UTC', async () => {
    const ny = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls/days?tz=America/New_York`,
      headers: headersFor(OWNER_EMAIL),
    });
    expect(ny.statusCode).toBe(200);
    expect(ny.json().days).toEqual([
      { day: '2026-08-11', calls: 1, orders: 0, transferred: 0, failed: 0 },
      { day: '2026-08-10', calls: 3, orders: 1, transferred: 1, failed: 1 },
      { day: '2026-08-09', calls: 1, orders: 0, transferred: 0, failed: 0 },
    ]);

    const utc = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls/days?tz=UTC`,
      headers: headersFor(OWNER_EMAIL),
    });
    // The 23:30 New York call is 03:30 the next morning in UTC.
    expect(utc.json().days.map((d: { day: string; calls: number }) => [d.day, d.calls])).toEqual([
      ['2026-08-11', 1],
      ['2026-08-10', 4],
    ]);
  });

  it('refuses a timezone it does not know', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls/days?tz=Mars/Olympus`,
      headers: headersFor(OWNER_EMAIL),
    });
    expect(res.statusCode).toBe(400);
  });

  it('exports the range as CSV, in local time, quoting what needs it, and audits the export', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls/export.csv?tz=America/New_York&to=${T.aug11.toISOString()}`,
      headers: headersFor(OWNER_EMAIL),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(/calls-calls-list-kitchen-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = res.payload.trimEnd().split('\n');
    expect(lines[0]).toBe(
      'started_local,started_utc,from,to,status,duration_seconds,customer_name,orders,order_total,recording,summary',
    );
    expect(lines).toHaveLength(1 + 4);
    // The order's call: name and money on the row.
    const ordered = lines.find((l) => l.includes(T.aug10Morning.toISOString()))!;
    expect(ordered).toContain('2026-08-10 10:00,');
    expect(ordered).toContain(',Jim,1,22.00,');
    // The late call reads as the 9th locally, and its quoted summary survives.
    const late = lines.find((l) => l.includes(T.aug9NightNY.toISOString()))!;
    expect(late.startsWith('2026-08-09 23:30,')).toBe(true);
    expect(late).toContain('"Late one, ""quoted"" summary"');
    // Never the other location's call.
    expect(res.payload).not.toContain(otherLocationId);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'calls.exported', targetId: locationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).not.toBeNull();
    expect(audit?.metadata).toMatchObject({ tz: 'America/New_York', to: T.aug11.toISOString() });
  });

  it('does not let staff export', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/calls/export.csv`,
      headers: headersFor(STAFF_EMAIL),
    });
    expect(res.statusCode).toBe(403);
  });
});
