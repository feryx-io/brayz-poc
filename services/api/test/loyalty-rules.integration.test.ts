import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file: loyalty-rules owns 0128 / 8822 — and its OWN location,
// so its loyalty-settings writes never race the loyalty.integration file.
const TEST_NUMBER = '+15185550128';
const CALLER = '+15185558822';
const OWNER_EMAIL = `loyalty-rules-owner-${Date.now()}@brayz.test`;

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
const ownerHeaders = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

const THIS_MONTH = new Date().getMonth() + 1;

describe.skipIf(!dbUp)('Loyalty rules (VIP + birthday + win-back + stats)', () => {
  let app: App;
  let locationId: string;
  let itemId: string;
  let userId: string | undefined;
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

  async function placeOrder(quantity: number) {
    const callId = await newCall();
    return app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId: itemId, name: 'Rules Special', quantity }],
        customerName: 'Vip Vera',
      },
    });
  }

  beforeAll(async () => {
    app = await buildApp();
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } });

    // A dedicated location (+ menu + number) so nothing here races other files.
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Rules Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    const menu = await prisma.menu.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        name: 'Rules Menu',
        active: true,
        categories: {
          create: {
            name: 'Mains',
            items: { create: { name: 'Rules Special', priceCents: 1499, available: true } },
          },
        },
      },
      include: { categories: { include: { items: true } } },
    });
    itemId = menu.categories[0].items[0].id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });

    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });

    // Program with every rule on. rewardPoints is set unreachably high so
    // redemption never interferes with the bonus math here.
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/loyalty-settings`,
      headers: { ...ownerHeaders, 'content-type': 'application/json' },
      payload: {
        enabled: true,
        pointsPerDollar: 10,
        rewardPoints: 1_000_000,
        rewardCents: 300,
        vipEnabled: true,
        vipSpendCents: 2000, // VIP after $20 lifetime
        vipPointsMultiplier: 2,
        birthdayEnabled: true,
        birthdayBonusPoints: 250,
        winbackEnabled: true,
        winbackDays: 60,
        winbackBonusPoints: 150,
      },
    });
    if (put.statusCode !== 200) throw new Error(`settings PUT failed: ${put.body}`);
  });

  afterAll(async () => {
    if (guestId) await prisma.guest.deleteMany({ where: { id: guestId } }).catch(() => {});
    await prisma.guestPhoneNumber.deleteMany({ where: { tenantId: SEEDED_TENANT, e164: CALLER } }).catch(() => {});
    await prisma.order.deleteMany({ where: { customerPhone: CALLER } }).catch(() => {});
    await prisma.call.deleteMany({ where: { toNumber: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('earns at the base rate before the VIP threshold', async () => {
    const res = await placeOrder(2); // $29.98 → 29 dollars × 10 = 290 (not VIP yet: pre-order spend is 0)
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      pointsEarned: 290,
      vip: false,
      birthdayBonusPoints: 0,
      winbackBonusPoints: 0,
    });
    const gpn = await prisma.guestPhoneNumber.findUnique({
      where: { tenantId_e164: { tenantId: SEEDED_TENANT, e164: CALLER } },
      select: { guestId: true },
    });
    guestId = gpn!.guestId;
  });

  it('saves the birthday from the voice tool', async () => {
    const callId = await newCall();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/guest/memory`,
      headers: nodeHeaders,
      payload: { birthdayMonth: THIS_MONTH, birthdayDay: 15 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saved: true });
    const guest = await prisma.guest.findUnique({ where: { id: guestId! } });
    expect(guest?.birthdayMonth).toBe(THIS_MONTH);
    expect(guest?.birthdayDay).toBe(15);
  });

  it('earns at the VIP multiplier past the threshold, and grants the birthday bonus once', async () => {
    const res = await placeOrder(1); // pre-order spend $29.98 ≥ $20 → VIP: 14 × 10 × 2 = 280
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      pointsEarned: 280,
      vip: true,
      birthdayBonusPoints: 250, // first order in the birthday month this year
      winbackBonusPoints: 0, // previous order was moments ago
    });

    // VIP shows up on the voice guest context and the dashboard profile.
    const callId = await newCall();
    const guestCtx = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/guest`,
      headers: nodeHeaders,
    });
    expect(guestCtx.json()).toMatchObject({ isReturning: true, vip: true });
    const detail = await app.inject({ method: 'GET', url: `/v1/guests/${guestId}`, headers: ownerHeaders });
    expect(detail.json().vip).toBe(true);
  });

  it('never grants the birthday bonus twice in a year, and win-back needs a real lapse', async () => {
    const res = await placeOrder(1);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ birthdayBonusPoints: 0, winbackBonusPoints: 0 });
    const events = await prisma.loyaltyEvent.findMany({
      where: { account: { guestId: guestId! }, type: 'birthday' },
    });
    expect(events).toHaveLength(1);
  });

  it('grants the win-back bonus when the guest returns after the lapse window', async () => {
    // Age every prior order past the 60-day window.
    const past = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000);
    await prisma.order.updateMany({ where: { guestId: guestId! }, data: { createdAt: past } });

    // The pre-order loyalty status advertises the pending bonus to the bot.
    const callId = await newCall();
    const status = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/loyalty`,
      headers: nodeHeaders,
    });
    expect(status.json()).toMatchObject({
      vip: true,
      birthdayBonusAvailable: false, // already claimed this year
      winbackBonusAvailable: true,
      winbackBonusPoints: 150,
    });

    const res = await placeOrder(1);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ winbackBonusPoints: 150, vip: true });
    const events = await prisma.loyaltyEvent.findMany({
      where: { account: { guestId: guestId! }, type: 'winback' },
    });
    expect(events).toHaveLength(1);
  });

  it('reports program analytics for the location', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/loyalty-stats`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json();
    expect(stats.enabled).toBe(true);
    expect(stats.members).toBe(1);
    expect(stats.vipCount).toBe(1);
    // 290 + 280 + 280 + 280 earned, +250 birthday, +150 winback — all still held.
    expect(stats.pointsOutstanding).toBe(290 + 280 + 280 + 280 + 250 + 150);
    // Event timestamps are independent of the backdated orders — every earn
    // happened moments ago, so all four are inside the 30-day window.
    expect(stats.last30Days.pointsEarned).toBe(290 + 280 + 280 + 280);
    expect(stats.last30Days.birthdayBonuses).toBe(1);
    expect(stats.last30Days.winbackBonuses).toBe(1);
    expect(stats.last30Days.redemptions).toBe(0);
  });
});
