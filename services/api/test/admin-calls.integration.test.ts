import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
// BRAYZ_NODE_SHARED_SECRET defaults to 'dev-only-change-me'.

const STAMP = Date.now();
const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const STAFF_EMAIL = `calls-staff-${STAMP}@brayz.test`;
const OWNER_EMAIL = `calls-owner-${STAMP}@brayz.test`;
const NODE_A = `test-node-a-${STAMP}`;
const NODE_B = `test-node-b-${STAMP}`;
const NODE_C = `test-node-c-${STAMP}`;
// A number nobody else's tests use, for the node-attribution round trip.
const LINE = `+1518${String(STAMP).slice(-7)}`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const json = { 'content-type': 'application/json' };
const staff = { 'x-brayz-user-email': STAFF_EMAIL };
const owner = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };
const node = { ...json, 'x-brayz-node-secret': 'dev-only-change-me' };

const MIN = 60_000;

/**
 * The staff portal's live call count and call history. Both read across every
 * tenant, so beyond the numbers what matters is who may ask and that only
 * counts come back. The database is shared with other suites, so assertions
 * are about this file's own nodes and a window in 2001 nobody else writes to.
 */
describe.skipIf(!dbUp)('Admin — live calls and call history', () => {
  let app: App;
  let tenantId: string;
  let locationId: string;

  beforeAll(async () => {
    app = await buildApp();
    await prisma.user.create({
      data: { email: STAFF_EMAIL, authSubject: `dev:${STAFF_EMAIL}`, platformRole: 'support' },
    });
    const ownerUser = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: `dev:${OWNER_EMAIL}` },
    });
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: ownerUser.id, role: 'owner' },
    });

    const tenant = await prisma.tenant.create({ data: { name: `Live Calls Diner ${STAMP}` } });
    tenantId = tenant.id;
    const location = await prisma.location.create({
      data: { tenantId, name: 'Main St', timezone: 'America/New_York' },
    });
    locationId = location.id;

    const now = Date.now();
    const call = (at: number, nodeId: string | null, ended: boolean, startedAt?: Date) =>
      prisma.call.create({
        data: {
          tenantId,
          locationId,
          nodeId,
          status: ended ? 'completed' : 'in_progress',
          fromNumber: '+15555550199',
          startedAt: startedAt ?? new Date(now - at),
          endedAt: ended ? new Date(now - at + MIN) : null,
        },
      });

    await Promise.all([
      // Node A: two on the line, one finished.
      call(5 * MIN, NODE_A, false),
      call(2 * MIN, NODE_A, false),
      call(30 * MIN, NODE_A, true),
      // Node B: one on the line, and one whose end was never recorded.
      call(1 * MIN, NODE_B, false),
      call(5 * 60 * MIN, NODE_B, false),
      // History, far from anything else in the database. New York is UTC-5 in
      // January, so the first of these is Jan 1 there and Jan 2 in UTC.
      call(0, NODE_A, true, new Date('2001-01-02T03:30:00Z')),
      call(0, NODE_A, true, new Date('2001-01-02T15:00:00Z')),
      call(0, NODE_A, true, new Date('2001-01-03T12:00:00Z')),
    ]);
  });

  afterAll(async () => {
    await prisma.phoneNumber.deleteMany({ where: { e164Number: LINE } });
    await prisma.voiceNode.deleteMany({ where: { nodeId: { in: [NODE_A, NODE_B, NODE_C] } } });
    await prisma.tenant.deleteMany({ where: { id: tenantId } }); // calls + location cascade
    await prisma.userTenantMembership.deleteMany({ where: { user: { email: OWNER_EMAIL } } });
    await prisma.platformAuditLog.deleteMany({ where: { actorEmail: STAFF_EMAIL } });
    await prisma.user.deleteMany({ where: { email: { in: [STAFF_EMAIL, OWNER_EMAIL] } } });
    await app.close();
  });

  it('is for Brayz staff only', async () => {
    for (const url of ['/v1/admin/calls/live', '/v1/admin/calls/histogram']) {
      expect((await app.inject({ method: 'GET', url, headers: owner })).statusCode, url).toBe(403);
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
  });

  describe('live', () => {
    it('counts calls in progress per node, and a finished call is not one', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/calls/live', headers: staff });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const a = body.nodes.find((n: { nodeId: string }) => n.nodeId === NODE_A);
      const b = body.nodes.find((n: { nodeId: string }) => n.nodeId === NODE_B);
      expect(a).toMatchObject({ active: 2, last24Hours: 3 });
      expect(b).toMatchObject({ active: 1, last24Hours: 2 });
      expect(a.lastCallAt).toBeTruthy();
      // Other suites may have calls open too; ours are at least in the total.
      expect(body.active).toBeGreaterThanOrEqual(3);
    });

    it('reports a call whose end was never recorded as stale, not live', async () => {
      const body = (await app.inject({ method: 'GET', url: '/v1/admin/calls/live', headers: staff })).json();
      expect(body.stale).toBeGreaterThanOrEqual(1);
      expect(body.activeWindowMinutes).toBe(120);
      const b = body.nodes.find((n: { nodeId: string }) => n.nodeId === NODE_B);
      expect(b.active).toBe(1); // the five-hour-old one is not in it
    });

    it('lists a node from its heartbeat, before it takes a call, and judges its health', async () => {
      const well = {
        version: '0.51.1',
        serviceActive: true,
        live: true,
        ready: true,
        diskUsedPct: 15,
        memUsedPct: 24,
      };
      await prisma.voiceNode.createMany({
        data: [
          // Just booted, no calls yet.
          { nodeId: NODE_C, region: 'us-east4', environment: 'test', health: well, lastSeenAt: new Date() },
          // Took calls above, but its last beat was ten minutes ago.
          { nodeId: NODE_B, region: 'us-east4', environment: 'test', health: well, lastSeenAt: new Date(Date.now() - 10 * MIN) },
          // Beating, but its disk is nearly full.
          { nodeId: NODE_A, region: 'us-east4', environment: 'test', activeCalls: 2, health: { ...well, diskUsedPct: 95 }, lastSeenAt: new Date() },
        ],
      });

      const body = (await app.inject({ method: 'GET', url: '/v1/admin/calls/live', headers: staff })).json();
      const byId = (id: string) => body.nodes.find((n: { nodeId: string }) => n.nodeId === id);

      expect(byId(NODE_C)).toMatchObject({ active: 0, last24Hours: 0, health: { state: 'healthy', reasons: [] } });
      expect(byId(NODE_C).health.snapshot.version).toBe('0.51.1');
      expect(byId(NODE_B).health.state).toBe('down');
      expect(byId(NODE_B).health.reasons[0]).toMatch(/No heartbeat for 10 min/);
      expect(byId(NODE_B).active).toBe(1); // calls are still counted from the call rows
      expect(byId(NODE_A).health).toMatchObject({
        state: 'degraded',
        reasons: ['Disk 95% full'],
        reportedActiveCalls: 2,
      });
    });

    it('returns counts, never who is calling or which restaurant', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/calls/live', headers: staff });
      const text = res.body;
      expect(text).not.toContain('+15555550199');
      expect(text).not.toContain(tenantId);
      expect(text).not.toContain(locationId);
    });
  });

  describe('histogram', () => {
    const hist = (qs: string) =>
      app.inject({ method: 'GET', url: `/v1/admin/calls/histogram?${qs}`, headers: staff });

    it('cuts days in the viewer’s timezone and fills the gaps with zero', async () => {
      const ny = await hist(
        'bucket=day&tz=America/New_York&from=2001-01-01T05:00:00Z&to=2001-01-05T05:00:00Z',
      );
      expect(ny.statusCode).toBe(200);
      expect(ny.json().points).toEqual([
        { start: '2001-01-01T00:00', calls: 1 },
        { start: '2001-01-02T00:00', calls: 1 },
        { start: '2001-01-03T00:00', calls: 1 },
        { start: '2001-01-04T00:00', calls: 0 },
      ]);
      expect(ny.json().total).toBe(3);

      const utc = await hist('bucket=day&tz=UTC&from=2001-01-01T00:00:00Z&to=2001-01-04T00:00:00Z');
      expect(utc.json().points.map((p: { calls: number }) => p.calls)).toEqual([0, 2, 1]);
    });

    it('groups by month and by hour', async () => {
      const months = await hist('bucket=month&tz=UTC&from=2000-12-01T00:00:00Z&to=2001-03-01T00:00:00Z');
      expect(months.json().points).toEqual([
        { start: '2000-12-01T00:00', calls: 0 },
        { start: '2001-01-01T00:00', calls: 3 },
        { start: '2001-02-01T00:00', calls: 0 },
      ]);

      const hours = await hist('bucket=hour&tz=UTC&from=2001-01-02T03:00:00Z&to=2001-01-02T06:00:00Z');
      expect(hours.json().points.map((p: { calls: number }) => p.calls)).toEqual([1, 0, 0]);
    });

    it('starts a week on Monday', async () => {
      // 2001-01-01 was a Monday; the 3rd is in the same week.
      const weeks = await hist('bucket=week&tz=UTC&from=2001-01-01T00:00:00Z&to=2001-01-15T00:00:00Z');
      expect(weeks.json().points).toEqual([
        { start: '2001-01-01T00:00', calls: 3 },
        { start: '2001-01-08T00:00', calls: 0 },
      ]);
    });

    it('refuses what it cannot draw sensibly', async () => {
      expect((await hist('bucket=minute')).statusCode).toBe(400);
      expect((await hist('tz=Mars/Olympus_Mons')).statusCode).toBe(400);
      expect((await hist('from=2001-01-02T00:00:00Z&to=2001-01-01T00:00:00Z')).statusCode).toBe(400);
      const tooMany = await hist('bucket=hour&from=2000-01-01T00:00:00Z&to=2001-01-01T00:00:00Z');
      expect(tooMany.statusCode).toBe(400);
      expect(tooMany.json().error.code).toBe('too_many_buckets');
    });
  });

  describe('node attribution', () => {
    beforeAll(async () => {
      await prisma.phoneNumber.create({
        data: { tenantId, locationId, e164Number: LINE, active: true },
      });
    });

    it('stores the node a call came through', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/calls',
        headers: node,
        payload: { toNumber: LINE, fromNumber: '+15555550101', nodeId: NODE_A },
      });
      expect(res.statusCode).toBe(201);
      const row = await prisma.call.findUnique({ where: { id: res.json().id }, select: { nodeId: true } });
      expect(row?.nodeId).toBe(NODE_A);
    });

    it('never fails a call over a malformed node id — it just drops it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/calls',
        headers: node,
        payload: { toNumber: LINE, nodeId: 'not a node id; drop table' },
      });
      expect(res.statusCode).toBe(201);
      const row = await prisma.call.findUnique({ where: { id: res.json().id }, select: { nodeId: true } });
      expect(row?.nodeId).toBeNull();
    });
  });
});
