import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
// BRAYZ_NODE_SHARED_SECRET defaults to 'dev-only-change-me'. BRAYZ_TRANSFER_SIP_DOMAIN
// is unset, so only a sip: destination can be forwarded to.

const STAMP = Date.now();
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const OWNER_EMAIL = `trial-owner-${STAMP}@brayz.test`;
const ADMIN_EMAIL = `trial-admin-${STAMP}@brayz.test`;
const SUPPORT_EMAIL = `trial-support-${STAMP}@brayz.test`;
// A line nobody else's suites use.
const LINE = `+1519${String(STAMP).slice(-7)}`;
const DAY = 86_400_000;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { locationBilling, requireEntitlement } = await import('../src/lib/billing.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const json = { 'content-type': 'application/json' };
const admin = { ...json, 'x-brayz-user-email': ADMIN_EMAIL };
const support = { ...json, 'x-brayz-user-email': SUPPORT_EMAIL };
const node = { ...json, 'x-brayz-node-secret': 'dev-only-change-me' };

/**
 * The 30-day free trial: Pro for every new account, out of service when it
 * lapses with nothing paid for, and the staff screen that watches and extends it.
 */
describe.skipIf(!dbUp)('Free trial', () => {
  let app: App;
  let tenantId = '';
  let locationId = '';
  let bareTenantId = '';
  const owner = () => ({ ...json, 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': tenantId });

  beforeAll(async () => {
    app = await buildApp();
    await prisma.user.create({ data: { email: ADMIN_EMAIL, authSubject: `dev:${ADMIN_EMAIL}`, platformRole: 'admin' } });
    await prisma.user.create({ data: { email: SUPPORT_EMAIL, authSubject: `dev:${SUPPORT_EMAIL}`, platformRole: 'support' } });
  });

  afterAll(async () => {
    await prisma.userTenantMembership.deleteMany({ where: { user: { email: OWNER_EMAIL } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, bareTenantId].filter(Boolean) } } });
    await prisma.platformAuditLog.deleteMany({ where: { actorEmail: { in: [ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, ADMIN_EMAIL, SUPPORT_EMAIL] } } });
    await app.close();
  });

  it('starts every new account on a 30-day Pro trial', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { ...json, 'x-brayz-user-email': OWNER_EMAIL },
      payload: { name: `Trial Pizza ${STAMP}` },
    });
    expect(res.statusCode).toBe(201);
    tenantId = res.json().id;

    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(t.trialEndsAt!.getTime() - t.trialStartedAt!.getTime()).toBe(30 * DAY);
    expect(Math.abs(t.trialStartedAt!.getTime() - Date.now())).toBeLessThan(60_000);

    const trial = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/trial`, headers: owner() });
    expect(trial.statusCode).toBe(200);
    expect(trial.json()).toMatchObject({ trial: { active: true, daysLeft: 30 }, converted: false, plan: 'pro', trialDays: 30 });
  });

  it('serves every location it opens on Pro', async () => {
    const loc = await prisma.location.create({ data: { tenantId, name: 'Main St', timezone: 'America/New_York' } });
    locationId = loc.id;
    const billing = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/billing`, headers: owner() });
    expect(billing.statusCode).toBe(200);
    expect(billing.json()).toMatchObject({ source: 'trial', plan: 'pro', inService: true, trial: { active: true } });
    expect(billing.json().entitlements).toContain('staff_voices');
    await expect(requireEntitlement(locationId, 'staff_voices')).resolves.toBeUndefined();
  });

  it('answers calls as usual while the trial runs', async () => {
    await prisma.phoneNumber.create({ data: { tenantId, locationId, e164Number: LINE, active: true } });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: node,
      payload: { toNumber: LINE, fromNumber: '+15555550100' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().service).toEqual({ inService: true, reason: null, forwardTo: null });
  });

  describe('once it lapses with nothing paid for', () => {
    beforeAll(async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    });

    it('stops answering: the call rings through to the restaurant, and is recorded', async () => {
      await prisma.locationTransferTarget.create({
        data: { locationId, key: 'manager', label: 'the manager', destination: 'sip:+15185559999@pstn.example.test' },
      });
      const res = await app.inject({ method: 'POST', url: '/v1/calls', headers: node, payload: { toNumber: LINE } });
      expect(res.statusCode).toBe(201);
      expect(res.json().service).toEqual({
        inService: false,
        reason: 'trial_expired',
        forwardTo: 'sip:+15185559999@pstn.example.test',
      });
      const events = await prisma.callEvent.findMany({ where: { callId: res.json().id }, select: { eventType: true } });
      expect(events.map((e) => e.eventType)).toContain('call.out_of_service');
    });

    it('says there is nowhere to forward when the restaurant has no reachable number', async () => {
      await prisma.locationTransferTarget.deleteMany({ where: { locationId } });
      // A bare number cannot become a SIP URI without BRAYZ_TRANSFER_SIP_DOMAIN.
      await prisma.location.update({ where: { id: locationId }, data: { escalationPhone: '+15185558888' } });
      const res = await app.inject({ method: 'POST', url: '/v1/calls', headers: node, payload: { toNumber: LINE } });
      expect(res.json().service).toEqual({ inService: false, reason: 'trial_expired', forwardTo: null });
    });

    it('refuses paid features whatever BILLING_ENFORCED says, and tells the owner why', async () => {
      await expect(requireEntitlement(locationId, 'orders')).rejects.toThrow(/free trial has ended/);
      const billing = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/billing`, headers: owner() });
      expect(billing.json()).toMatchObject({ source: 'trial_expired', inService: false, plan: null, entitlements: [] });
      const trial = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/trial`, headers: owner() });
      expect(trial.json()).toMatchObject({ trial: { active: false, daysLeft: 0 }, converted: false });
    });

    it('comes back the moment a plan is paid for', async () => {
      await prisma.locationSubscription.create({ data: { tenantId, locationId, plan: 'growth', status: 'active' } });
      const res = await app.inject({ method: 'POST', url: '/v1/calls', headers: node, payload: { toNumber: LINE } });
      expect(res.json().service.inService).toBe(true);
      const billing = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/billing`, headers: owner() });
      expect(billing.json()).toMatchObject({ source: 'subscription', plan: 'growth', inService: true });
      const trial = await app.inject({ method: 'GET', url: `/v1/tenants/${tenantId}/trial`, headers: owner() });
      expect(trial.json().converted).toBe(true);
      await prisma.locationSubscription.deleteMany({ where: { locationId } });
    });
  });

  it('leaves an account from before trials exactly as it was', async () => {
    const billing = await locationBilling(SEEDED_LOCATION);
    expect(billing).toMatchObject({ source: 'unrestricted', inService: true, trial: null });
  });

  describe('staff', () => {
    it('lists trials with their progress — support and admins alike — and records who looked', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: new Date(Date.now() + 5 * DAY) } });
      const res = await app.inject({ method: 'GET', url: '/v1/admin/trials?state=all', headers: support });
      expect(res.statusCode).toBe(200);
      const row = res.json().trials.find((t: { tenantId: string }) => t.tenantId === tenantId);
      expect(row).toMatchObject({
        state: 'ending',
        daysLeft: 5,
        ownerEmail: OWNER_EMAIL,
        setup: { locations: 1, numbersLive: 1, menuItems: 0, firstOrderAt: null },
      });
      expect(row.setup.firstCallAt).toBeTruthy();
      expect(row.usage.callsDuringTrial).toBeGreaterThanOrEqual(1);
      expect(res.json().counts.ending).toBeGreaterThanOrEqual(1);
      expect(res.json().trialDays).toBe(30);

      const audited = await prisma.platformAuditLog.count({
        where: { actorEmail: SUPPORT_EMAIL, action: 'admin.trials.listed' },
      });
      expect(audited).toBe(1);

      const expired = await app.inject({ method: 'GET', url: '/v1/admin/trials?state=expired', headers: support });
      expect(expired.json().trials.map((t: { tenantId: string }) => t.tenantId)).not.toContain(tenantId);
    });

    it('is not for customers', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/admin/trials', headers: owner() });
      expect(res.statusCode).toBe(403);
    });

    it('lets only an admin extend, and only with a reason and a sensible end', async () => {
      const url = `/v1/admin/trials/${tenantId}/extend`;
      const post = (headers: Record<string, string>, payload: object) =>
        app.inject({ method: 'POST', url, headers, payload });
      expect((await post(support, { days: 7, reason: 'They asked nicely' })).statusCode).toBe(403);
      expect((await post(admin, { days: 7 })).statusCode).toBe(400);
      expect((await post(admin, { days: 7, endsAt: new Date(Date.now() + 9 * DAY), reason: 'Both at once' })).statusCode).toBe(400);
      expect((await post(admin, { endsAt: new Date(Date.now() - DAY), reason: 'In the past' })).statusCode).toBe(400);
      expect((await post(admin, { days: 400, reason: 'Far too long' })).statusCode).toBe(400);
    });

    it('adds days to the current end while the trial runs', async () => {
      const before = (await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).trialEndsAt!;
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/trials/${tenantId}/extend`,
        headers: admin,
        payload: { days: 14, reason: 'Waiting on their POS install' },
      });
      expect(res.statusCode).toBe(200);
      expect(new Date(res.json().endsAt).getTime()).toBe(before.getTime() + 14 * DAY);
      const entry = await prisma.platformAuditLog.findFirst({
        where: { actorEmail: ADMIN_EMAIL, action: 'admin.trial.extended', targetId: tenantId },
      });
      expect(entry?.metadata).toMatchObject({ days: 14, reason: 'Waiting on their POS install' });
    });

    it('restarts from today when the trial has already lapsed', async () => {
      await prisma.tenant.update({ where: { id: tenantId }, data: { trialEndsAt: new Date(Date.now() - 3 * DAY) } });
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/trials/${tenantId}/extend`,
        headers: admin,
        payload: { days: 7, reason: 'Owner was in hospital' },
      });
      expect(res.statusCode).toBe(200);
      expect(Math.abs(new Date(res.json().endsAt).getTime() - (Date.now() + 7 * DAY))).toBeLessThan(60_000);
      expect(res.json().active).toBe(true);
    });

    it('starts a trial for an account that never had one', async () => {
      const bare = await prisma.tenant.create({ data: { name: `No Trial Deli ${STAMP}` } });
      bareTenantId = bare.id;
      const res = await app.inject({
        method: 'POST',
        url: `/v1/admin/trials/${bareTenantId}/extend`,
        headers: admin,
        payload: { days: 30, reason: 'Pilot customer moving to self-serve' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ granted: true, active: true, daysLeft: 30 });
      const t = await prisma.tenant.findUniqueOrThrow({ where: { id: bareTenantId } });
      expect(t.trialStartedAt).toBeTruthy();
      const entry = await prisma.platformAuditLog.findFirst({
        where: { action: 'admin.trial.granted', targetId: bareTenantId },
      });
      expect(entry).toBeTruthy();
    });

    it('shows the trial and its history on the customer page', async () => {
      const res = await app.inject({ method: 'GET', url: `/v1/admin/customers/${tenantId}`, headers: admin });
      expect(res.statusCode).toBe(200);
      const trial = res.json().trial;
      expect(trial).toMatchObject({ active: true });
      expect(trial.history.length).toBeGreaterThanOrEqual(2);
      expect(trial.history[0]).toMatchObject({ actorEmail: ADMIN_EMAIL, reason: 'Owner was in hospital' });
    });
  });
});
