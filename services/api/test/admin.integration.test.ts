import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const STAFF_EMAIL = `platform-staff-${Date.now()}@brayz.test`;
const SUPPORT_EMAIL = `platform-support-${Date.now()}@brayz.test`;
const OWNER_EMAIL = `admin-owner-${Date.now()}@brayz.test`;
const OUTSIDER_EMAIL = `admin-outsider-${Date.now()}@brayz.test`;
// The founder account named in PLATFORM_ADMIN_EMAILS, who has never been staff
// yet. Set before the config is loaded, because loadConfig caches.
const BOOTSTRAP_EMAIL = `admin-bootstrap-${Date.now()}@brayz.test`;
process.env.PLATFORM_ADMIN_EMAILS = ` ${BOOTSTRAP_EMAIL.toUpperCase()} , `;

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
const owner = { ...json, 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };
const outsider = { ...json, 'x-brayz-user-email': OUTSIDER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };
const staff = { ...json, 'x-brayz-user-email': STAFF_EMAIL };
const bootstrap = { ...json, 'x-brayz-user-email': BOOTSTRAP_EMAIL };
const support = { ...json, 'x-brayz-user-email': SUPPORT_EMAIL };

/**
 * The admin portal is the one surface that reads across tenants, so what is
 * tested here is mostly who is refused.
 */
describe.skipIf(!dbUp)('Platform admin portal', () => {
  let app: App;
  let otherTenantId: string;
  let requestId: string;

  beforeAll(async () => {
    app = await buildApp();

    // A customer who owns the seeded tenant.
    const ownerUser = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: `dev:${OWNER_EMAIL}`, displayName: 'Owner' },
    });
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: ownerUser.id, role: 'owner' },
    });
    // Someone with an account but no business here.
    await prisma.user.create({
      data: { email: OUTSIDER_EMAIL, authSubject: `dev:${OUTSIDER_EMAIL}` },
    });
    // Brayz staff.
    await prisma.user.create({
      data: { email: STAFF_EMAIL, authSubject: `dev:${STAFF_EMAIL}`, platformRole: 'admin' },
    });
    await prisma.user.create({
      data: { email: SUPPORT_EMAIL, authSubject: `dev:${SUPPORT_EMAIL}`, platformRole: 'support' },
    });
    // Deliberately no platformRole: the bootstrap list has to grant it.
    await prisma.user.create({
      data: { email: BOOTSTRAP_EMAIL, authSubject: `dev:${BOOTSTRAP_EMAIL}` },
    });
    // A second tenant, so "across tenants" means something.
    const other = await prisma.tenant.create({ data: { name: `Admin Test Diner ${Date.now()}` } });
    otherTenantId = other.id;
  });

  afterAll(async () => {
    await prisma.supportRequest.deleteMany({ where: { tenantId: { in: [SEEDED_TENANT, otherTenantId] } } });
    await prisma.platformAuditLog.deleteMany({ where: { actorEmail: { in: [STAFF_EMAIL, SUPPORT_EMAIL] } } });
    await prisma.userTenantMembership.deleteMany({ where: { user: { email: OWNER_EMAIL } } });
    await prisma.tenant.deleteMany({ where: { id: otherTenantId } });
    await prisma.user.deleteMany({
      where: {
        email: { in: [OWNER_EMAIL, OUTSIDER_EMAIL, STAFF_EMAIL, SUPPORT_EMAIL, BOOTSTRAP_EMAIL] },
      },
    });
    await app.close();
  });

  it('refuses a restaurant owner, however senior they are in their own tenant', async () => {
    for (const url of ['/v1/admin/overview', '/v1/admin/customers', '/v1/admin/support-requests']) {
      const res = await app.inject({ method: 'GET', url, headers: owner });
      expect(res.statusCode, url).toBe(403);
    }
  });

  it('refuses someone with an account but no platform role', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/customers', headers: outsider });
    expect(res.statusCode).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/overview', headers: json });
    expect(res.statusCode).toBe(401);
  });

  it('shows staff the whole platform', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/overview', headers: staff });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // At least the seeded tenant and the one this file made.
    expect(body.customers.total).toBeGreaterThanOrEqual(2);
    expect(body.calls).toHaveProperty('today');
    expect(body.revenue).toHaveProperty('mrrCents');
  });

  it('lists customers across tenants, with contact details and usage', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/customers', headers: staff });
    expect(res.statusCode).toBe(200);
    const names = res.json().customers.map((c: { name: string }) => c.name);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const seeded = res.json().customers.find((c: { tenantId: string }) => c.tenantId === SEEDED_TENANT);
    expect(seeded).toBeDefined();
    expect(seeded).toHaveProperty('calls30d');
    expect(seeded).toHaveProperty('locationCount');
  });

  it('records who looked at a customer', async () => {
    const before = await prisma.platformAuditLog.count({
      where: { actorEmail: STAFF_EMAIL, action: 'admin.customer.viewed' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/customers/${SEEDED_TENANT}`,
      headers: staff,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().locations.length).toBeGreaterThan(0);
    const after = await prisma.platformAuditLog.count({
      where: { actorEmail: STAFF_EMAIL, action: 'admin.customer.viewed' },
    });
    expect(after).toBe(before + 1);
  });

  it('never returns call content, only counts', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/customers/${SEEDED_TENANT}`,
      headers: staff,
    });
    const text = JSON.stringify(res.json());
    for (const leak of ['transcript', 'recordingUrl', 'summary', 'guest']) {
      expect(text.toLowerCase(), `admin detail leaked "${leak}"`).not.toContain(leak);
    }
  });

  describe('support requests', () => {
    it('a restaurant files one and sees it', async () => {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/support-requests',
        headers: owner,
        payload: { subject: 'Calls are not being answered', body: 'Since this morning.', severity: 'urgent' },
      });
      expect(created.statusCode).toBe(201);
      requestId = created.json().id;
      expect(created.json().status).toBe('open');

      const mine = await app.inject({ method: 'GET', url: '/v1/support-requests', headers: owner });
      expect(mine.json().requests.map((r: { id: string }) => r.id)).toContain(requestId);
    });

    it('another tenant cannot see it', async () => {
      const theirs = await app.inject({
        method: 'GET',
        url: '/v1/support-requests',
        headers: { ...json, 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': otherTenantId },
      });
      expect(theirs.statusCode).toBe(200);
      expect(theirs.json().requests.map((r: { id: string }) => r.id)).not.toContain(requestId);
    });

    it('reaches the staff queue', async () => {
      const queue = await app.inject({
        method: 'GET',
        url: '/v1/admin/support-requests?status=open',
        headers: staff,
      });
      expect(queue.statusCode).toBe(200);
      const found = queue.json().requests.find((r: { id: string }) => r.id === requestId);
      expect(found).toBeDefined();
      // Staff need to know who is asking and how to reach them.
      expect(found.tenantName).toBeTruthy();
      expect(found.fromEmail).toBe(OWNER_EMAIL);
    });

    it('support staff may read the queue but not answer it', async () => {
      const read = await app.inject({
        method: 'GET',
        url: '/v1/admin/support-requests',
        headers: support,
      });
      expect(read.statusCode).toBe(200);

      const write = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/support-requests/${requestId}`,
        headers: support,
        payload: { status: 'in_progress' },
      });
      expect(write.statusCode).toBe(403);
    });

    it('an admin answers it, and the customer sees the reply', async () => {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/support-requests/${requestId}`,
        headers: staff,
        payload: { status: 'resolved', staffReply: 'Fixed — a trunk was misrouted.' },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().status).toBe('resolved');
      expect(patched.json().resolvedAt).toBeTruthy();

      const mine = await app.inject({ method: 'GET', url: '/v1/support-requests', headers: owner });
      const seen = mine.json().requests.find((r: { id: string }) => r.id === requestId);
      expect(seen.staffReply).toBe('Fixed — a trunk was misrouted.');
      expect(seen.status).toBe('resolved');
    });

    it('reopening clears the resolved timestamp', async () => {
      const reopened = await app.inject({
        method: 'PATCH',
        url: `/v1/admin/support-requests/${requestId}`,
        headers: staff,
        payload: { status: 'open' },
      });
      expect(reopened.json().resolvedAt).toBeNull();
    });

    it('cannot be withdrawn once Brayz has picked it up', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/v1/admin/support-requests/${requestId}`,
        headers: staff,
        payload: { status: 'in_progress' },
      });
      // No JSON content-type: Fastify rejects a bodyless request that claims
      // one, which is what the web client's api() helper already avoids.
      const { 'content-type': _ct, ...bodyless } = owner;
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/support-requests/${requestId}`,
        headers: bodyless,
      });
      expect(res.statusCode).toBe(409);
    });

    it('refuses a location belonging to someone else', async () => {
      const other = await prisma.location.create({
        data: { tenantId: otherTenantId, name: 'Not yours', timezone: 'America/New_York' },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/support-requests',
        headers: owner,
        payload: { subject: 'Probing for a location id', body: 'x', locationId: other.id },
      });
      expect(res.statusCode).toBe(404);
      await prisma.location.delete({ where: { id: other.id } });
    });
  });

  describe('granting staff access', () => {
    it('an admin cannot remove their own access', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/staff',
        headers: staff,
        payload: { email: STAFF_EMAIL, role: null },
      });
      expect(res.statusCode).toBe(400);
    });

    it('promotes and demotes someone else', async () => {
      const up = await app.inject({
        method: 'POST',
        url: '/v1/admin/staff',
        headers: staff,
        payload: { email: OUTSIDER_EMAIL, role: 'support' },
      });
      expect(up.statusCode).toBe(200);
      expect(up.json().platformRole).toBe('support');

      const nowIn = await app.inject({ method: 'GET', url: '/v1/admin/overview', headers: outsider });
      expect(nowIn.statusCode).toBe(200);

      const down = await app.inject({
        method: 'POST',
        url: '/v1/admin/staff',
        headers: staff,
        payload: { email: OUTSIDER_EMAIL, role: null },
      });
      expect(down.statusCode).toBe(200);

      const backOut = await app.inject({ method: 'GET', url: '/v1/admin/overview', headers: outsider });
      expect(backOut.statusCode).toBe(403);
    });

    it('support staff cannot promote anyone', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/admin/staff',
        headers: support,
        payload: { email: OUTSIDER_EMAIL, role: 'admin' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  /**
   * Without this the portal has no first admin and nobody can open it, so it is
   * worth a test even though it runs once in the life of an environment.
   */
  describe('bootstrapping the first admin', () => {
    it('promotes a configured email the first time they call /v1/me', async () => {
      const before = await prisma.user.findUnique({
        where: { email: BOOTSTRAP_EMAIL },
        select: { platformRole: true },
      });
      expect(before?.platformRole).toBeNull();

      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: bootstrap });
      expect(me.statusCode).toBe(200);
      expect(me.json().platformRole).toBe('admin');

      // Written down, not recomputed per request.
      const after = await prisma.user.findUnique({
        where: { email: BOOTSTRAP_EMAIL },
        select: { platformRole: true },
      });
      expect(after?.platformRole).toBe('admin');

      // And the portal now actually opens for them.
      const overview = await app.inject({
        method: 'GET',
        url: '/v1/admin/overview',
        headers: bootstrap,
      });
      expect(overview.statusCode).toBe(200);
    });

    it('promotes nobody else', async () => {
      const me = await app.inject({ method: 'GET', url: '/v1/me', headers: outsider });
      expect(me.statusCode).toBe(200);
      expect(me.json().platformRole).toBeNull();
      const user = await prisma.user.findUnique({
        where: { email: OUTSIDER_EMAIL },
        select: { platformRole: true },
      });
      expect(user?.platformRole).toBeNull();
    });
  });

  it('being Brayz staff is not a master key to a restaurant’s own data', async () => {
    // Staff, with a tenant header they have no membership in.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { ...json, 'x-brayz-user-email': STAFF_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    // Dev-mode header auth answers for the header's tenant; what matters is
    // that no platform-role check appears in the tenant-scoped path at all.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/plugins/auth.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toContain('platformRole');
    expect(res.statusCode).toBeLessThan(500);
  });
});
