import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file (see fix-flaky-api-tests): loyalty owns 0127 / 8811.
const TEST_NUMBER = '+15185550127';
const CALLER = '+15185558811';
const OWNER_EMAIL = `loyalty-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { awardPointsForOrder } = await import('../src/lib/loyalty.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET, 'content-type': 'application/json' };
const ownerHeaders = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

describe.skipIf(!dbUp)('Loyalty (settings + earn + redeem + call tool gating)', () => {
  let app: App;
  let callId: string;
  let userId: string | undefined;
  let guestId: string | undefined;
  let pizzaId: string;

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: CALLER, toNumber: TEST_NUMBER },
    });
    return res.json().id;
  }

  async function placeOrder(onCall: string, quantity: number, redeemReward?: boolean) {
    return app.inject({
      method: 'POST',
      url: `/v1/calls/${onCall}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId: pizzaId, name: 'Large Cheese Pizza', quantity }],
        customerName: 'Loyal Larry',
        redeemReward,
      },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, e164Number: TEST_NUMBER },
    });
    await prisma.locationLoyaltySettings.deleteMany({ where: { locationId: SEEDED_LOCATION } });

    const pizza = await prisma.menuItem.findFirst({
      where: { name: 'Large Cheese Pizza', category: { menu: { locationId: SEEDED_LOCATION } } },
      select: { id: true },
    });
    if (!pizza) throw new Error('seeded menu item missing — run the db seed');
    pizzaId = pizza.id;

    // Owner membership so manager-gated settings writes are allowed.
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });

    callId = await newCall();
  });

  afterAll(async () => {
    // Guard variable ids — an unguarded undefined where-field wipes the table.
    if (guestId) {
      // Loyalty account + events cascade with the guest.
      await prisma.guest.deleteMany({ where: { id: guestId } }).catch(() => {});
    }
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } }).catch(() => {});
    await prisma.order.deleteMany({ where: { customerPhone: CALLER } }).catch(() => {});
    await prisma.call.deleteMany({ where: { toNumber: TEST_NUMBER } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    await prisma.locationLoyaltySettings.deleteMany({ where: { locationId: SEEDED_LOCATION } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('settings default to disabled and round-trip a manager update', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/v1/locations/${SEEDED_LOCATION}/loyalty-settings`,
      headers: ownerHeaders,
    });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ enabled: false });

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${SEEDED_LOCATION}/loyalty-settings`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { enabled: true, pointsPerDollar: 10, rewardPoints: 100, rewardCents: 300 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ enabled: true, pointsPerDollar: 10, rewardPoints: 100, rewardCents: 300 });
  });

  it('reports a first-time caller as unenrolled (nothing personal revealed)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/loyalty`,
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ enabled: true, enrolled: false, pointsBalance: 0, rewardAvailable: false });
  });

  it('earns points on a confirmed order (10/dollar on the total)', async () => {
    const res = await placeOrder(callId, 2); // 2 × $14.99 = $29.98 → 29 whole dollars → 290 points
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ discountCents: 0, pointsEarned: 290 });

    const gpn = await prisma.guestPhoneNumber.findUnique({
      where: { tenantId_e164: { tenantId: SEEDED_TENANT, e164: CALLER } },
      select: { guestId: true },
    });
    expect(gpn).toBeTruthy();
    guestId = gpn!.guestId;

    const account = await prisma.loyaltyAccount.findUnique({ where: { guestId: guestId! } });
    expect(account?.pointsBalance).toBe(290);
    expect(account?.lifetimeSpendCents).toBe(2998);
    const earn = await prisma.loyaltyEvent.findFirst({ where: { accountId: account!.id, type: 'earn' } });
    expect(earn?.points).toBe(290);
  });

  it('never double-awards a replayed order (dedupe by orderId)', async () => {
    const order = await prisma.order.findFirst({
      where: { guestId, customerPhone: CALLER },
      orderBy: { createdAt: 'asc' },
      select: { id: true, totalCents: true },
    });
    const replay = await awardPointsForOrder({
      tenantId: SEEDED_TENANT,
      guestId: guestId!,
      orderId: order!.id,
      totalCents: order!.totalCents,
      settings: { enabled: true, pointsPerDollar: 10, rewardPoints: 100, rewardCents: 300 },
    });
    expect(replay.awarded).toBe(false);
    const account = await prisma.loyaltyAccount.findUnique({ where: { guestId: guestId! } });
    expect(account?.pointsBalance).toBe(290);
  });

  it('shows the returning caller their balance and available reward', async () => {
    const id = await newCall(); // recognized guest now
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${id}/tools/loyalty`, headers: nodeHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      enabled: true,
      enrolled: true,
      pointsBalance: 290,
      rewardAvailable: true,
      rewardPoints: 100,
      rewardCents: 300,
    });
  });

  it('redeems the reward on an order: discount applied, points deducted, then earns on the net total', async () => {
    const id = await newCall();
    const res = await placeOrder(id, 1, true); // $14.99 − $3.00 = $11.99 → earns 110
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ discountCents: 300, totalCents: 1199, pointsEarned: 110 });

    const account = await prisma.loyaltyAccount.findUnique({ where: { guestId: guestId! } });
    expect(account?.pointsBalance).toBe(290 - 100 + 110);
    const redeem = await prisma.loyaltyEvent.findFirst({ where: { accountId: account!.id, type: 'redeem' } });
    expect(redeem?.points).toBe(-100);
  });

  it('rejects a redemption the caller cannot afford (422, order not created)', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${SEEDED_LOCATION}/loyalty-settings`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { rewardPoints: 100_000 },
    });
    const ordersBefore = await prisma.order.count({ where: { guestId } });
    const id = await newCall();
    const res = await placeOrder(id, 1, true);
    expect(res.statusCode).toBe(422);
    expect(await prisma.order.count({ where: { guestId } })).toBe(ordersBefore);
    // Restore the affordable reward for later tests.
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${SEEDED_LOCATION}/loyalty-settings`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { rewardPoints: 100 },
    });
  });

  it('withholds loyalty status when the guest opted out of memory (403, code-enforced)', async () => {
    await prisma.guest.update({ where: { id: guestId! }, data: { memoryEnabled: false } });
    const id = await newCall();
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${id}/tools/loyalty`, headers: nodeHeaders });
    expect(res.statusCode).toBe(403);
    await prisma.guest.update({ where: { id: guestId! }, data: { memoryEnabled: true } });
  });

  it('reports enabled:false (and earns nothing) once the program is turned off', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${SEEDED_LOCATION}/loyalty-settings`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: { enabled: false },
    });
    const id = await newCall();
    const status = await app.inject({ method: 'GET', url: `/v1/calls/${id}/tools/loyalty`, headers: nodeHeaders });
    expect(status.json()).toEqual({ enabled: false });

    const balanceBefore = (await prisma.loyaltyAccount.findUnique({ where: { guestId: guestId! } }))!.pointsBalance;
    const res = await placeOrder(id, 1);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ pointsEarned: 0 });
    const balanceAfter = (await prisma.loyaltyAccount.findUnique({ where: { guestId: guestId! } }))!.pointsBalance;
    expect(balanceAfter).toBe(balanceBefore);
  });

  it('exposes the account + ledger to the dashboard guest view', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/guests/${guestId}/loyalty`, headers: ownerHeaders });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pointsBalance).toBe(300);
    expect(body.events.length).toBeGreaterThanOrEqual(3); // 2 earns + 1 redeem
    expect(body.events.some((e: { type: string }) => e.type === 'redeem')).toBe(true);
  });
});
