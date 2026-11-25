import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file — promotions owns 0133, and its own location + menu.
const TEST_NUMBER = '+15185550133';
const OWNER_EMAIL = `promo-owner-${Date.now()}@brayz.test`;

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
const ownerHeaders = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
};
const ownerHeadersNoBody = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
};

describe.skipIf(!dbUp)('Promotions (rules, eligibility, and the money)', () => {
  let app: App;
  let locationId: string;
  let menuItemId: string;
  let userId: string | undefined;
  const callIds: string[] = [];
  const promoIds: string[] = [];

  async function createPromo(body: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/promotions`,
      headers: ownerHeaders,
      payload: body,
    });
    if (res.statusCode === 201) promoIds.push(res.json().id);
    return res;
  }

  /** A fresh call from a given number, so each test controls its own guest. */
  async function newCall(fromNumber = '+15185551616'): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber, toNumber: TEST_NUMBER },
    });
    const id = res.json().id as string;
    callIds.push(id);
    return id;
  }

  async function placeOrder(callId: string, extra: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId, name: 'Pizza', quantity: 1 }],
        customerName: 'Gray',
        ...extra,
      },
    });
  }

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Promo Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });

    // $20.00 item, so percentages land on round numbers.
    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Promo Menu', active: true },
      select: { id: true },
    });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza' },
      select: { id: true },
    });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large pizza', priceCents: 2000 },
      select: { id: true },
    });
    menuItemId = item.id;

    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    for (const id of callIds) {
      await prisma.order.deleteMany({ where: { callId: id } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.guest.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    // Promotions, redemptions, and the menu cascade with the location.
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects a promotion with no value to give', async () => {
    expect((await createPromo({ name: 'Empty', kind: 'percent_off' })).statusCode).toBe(400);
    expect((await createPromo({ name: 'Empty', kind: 'amount_off' })).statusCode).toBe(400);
  });

  it('rejects a window that ends before it starts', async () => {
    const res = await createPromo({
      name: 'Backwards',
      kind: 'amount_off',
      amountOffCents: 500,
      startsAt: '2026-09-01T00:00:00Z',
      endsAt: '2026-08-01T00:00:00Z',
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates an offer, words it, and refuses a duplicate code', async () => {
    const res = await createPromo({
      code: 'five-off',
      name: '$5 off',
      description: 'Five dollars off any order.',
      kind: 'amount_off',
      amountOffCents: 500,
    });
    expect(res.statusCode).toBe(201);
    // Codes are said out loud, so they normalize — "five-off" and "FIVE-OFF"
    // must not become two promotions.
    expect(res.json().code).toBe('FIVE-OFF');
    expect(res.json().offer).toBe('$5 off');

    const dup = await createPromo({
      code: 'FIVE-OFF',
      name: 'Another',
      kind: 'amount_off',
      amountOffCents: 100,
    });
    expect(dup.statusCode).toBe(409);
  });

  it('applies a promotion by code and records the redemption', async () => {
    const callId = await newCall('+15185551617');
    const res = await placeOrder(callId, { promotionCode: 'five-off' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    // $20 item less $5 off.
    expect(body.totalCents).toBe(1500);
    expect(body.discountCents).toBe(500);
    expect(body.promotion).toMatchObject({ name: '$5 off', discountCents: 500 });

    const redemption = await prisma.promotionRedemption.findFirst({
      where: { orderId: body.id },
    });
    expect(redemption).toMatchObject({ discountCents: 500 });
  });

  it('refuses an unknown code rather than quietly charging full price', async () => {
    const callId = await newCall('+15185551618');
    const res = await placeOrder(callId, { promotionCode: 'NOPE' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('promotion_unavailable');
    // The order was not created behind the failed discount.
    expect(await prisma.order.count({ where: { callId } })).toBe(0);
  });

  it('holds a promotion to its minimum spend', async () => {
    const created = await createPromo({
      code: 'BIGORDER',
      name: '$8 off orders over $50',
      kind: 'amount_off',
      amountOffCents: 800,
      minSubtotalCents: 5000,
    });
    expect(created.statusCode).toBe(201);

    const callId = await newCall('+15185551619');
    const res = await placeOrder(callId, { promotionCode: 'BIGORDER' }); // $20 order
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('at least $50.00');
  });

  it('caps a percentage at its maximum, and never discounts below zero', async () => {
    // 90% of $20 is $18, but the cap is $5.
    const capped = await createPromo({
      code: 'CAPPED',
      name: '90% off, up to $5',
      kind: 'percent_off',
      percentOff: 90,
      amountOffCents: 500,
    });
    expect(capped.statusCode).toBe(201);
    const callId = await newCall('+15185551620');
    const res = await placeOrder(callId, { promotionCode: 'CAPPED' });
    expect(res.json().totalCents).toBe(1500);

    // Uncapped 100% takes the order to zero, never past it.
    const free = await createPromo({
      code: 'FREEBIE',
      name: '100% off',
      kind: 'percent_off',
      percentOff: 100,
    });
    expect(free.statusCode).toBe(201);
    const callId2 = await newCall('+15185551621');
    const res2 = await placeOrder(callId2, { promotionCode: 'FREEBIE' });
    expect(res2.json().totalCents).toBe(0);
    expect(res2.json().discountCents).toBe(2000);
  });

  it('honours a per-guest cap across calls', async () => {
    const created = await createPromo({
      code: 'ONCEONLY',
      name: 'One per customer',
      kind: 'amount_off',
      amountOffCents: 300,
      maxPerGuest: 1,
    });
    expect(created.statusCode).toBe(201);

    // Same caller number twice — the second call resolves to the same guest.
    const first = await placeOrder(await newCall('+15185551622'), { promotionCode: 'ONCEONLY' });
    expect(first.statusCode).toBe(201);
    const second = await placeOrder(await newCall('+15185551622'), { promotionCode: 'ONCEONLY' });
    expect(second.statusCode).toBe(422);
    expect(second.json().error.message).toContain('already been used');
  });

  it('honours a total redemption cap', async () => {
    const created = await createPromo({
      code: 'FIRSTTEN',
      name: 'First one only',
      kind: 'amount_off',
      amountOffCents: 200,
      maxRedemptions: 1,
      maxPerGuest: 5,
    });
    expect(created.statusCode).toBe(201);

    expect(
      (await placeOrder(await newCall('+15185551623'), { promotionCode: 'FIRSTTEN' })).statusCode,
    ).toBe(201);
    // A different guest, but the offer is spent.
    const second = await placeOrder(await newCall('+15185551624'), { promotionCode: 'FIRSTTEN' });
    expect(second.statusCode).toBe(422);
  });

  it('will not apply an offer outside its window or one switched off', async () => {
    const expired = await createPromo({
      code: 'EXPIRED',
      name: 'Last month',
      kind: 'amount_off',
      amountOffCents: 500,
      endsAt: '2020-01-01T00:00:00Z',
    });
    expect(expired.statusCode).toBe(201);
    const a = await placeOrder(await newCall('+15185551625'), { promotionCode: 'EXPIRED' });
    expect(a.statusCode).toBe(422);
    expect(a.json().error.message).toContain('isn’t running');

    const off = await createPromo({
      code: 'PAUSED',
      name: 'Switched off',
      kind: 'amount_off',
      amountOffCents: 500,
      active: false,
    });
    expect(off.statusCode).toBe(201);
    const b = await placeOrder(await newCall('+15185551626'), { promotionCode: 'PAUSED' });
    expect(b.statusCode).toBe(422);
  });

  it('offers the caller only what they qualify for', async () => {
    const vipOnly = await createPromo({
      code: 'VIPONLY',
      name: 'VIP thank-you',
      kind: 'amount_off',
      amountOffCents: 1000,
      audience: 'vip',
    });
    expect(vipOnly.statusCode).toBe(201);

    const callId = await newCall('+15185551627');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/promotions`,
      headers: { 'x-brayz-node-secret': NODE_SECRET },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json().promotions as Array<{ name: string; offer: string }>).map(
      (p) => p.name,
    );
    // A first-time caller is not VIP, so that offer is not on the list...
    expect(names).not.toContain('VIP thank-you');
    // ...but the open ones are, already worded for the bot to read out.
    expect(names).toContain('$5 off');
    const fiveOff = (res.json().promotions as Array<{ name: string; offer: string }>).find(
      (p) => p.name === '$5 off',
    );
    expect(fiveOff?.offer).toBe('$5 off');
  });

  it('refuses a VIP-only offer to a caller who is not one', async () => {
    const res = await placeOrder(await newCall('+15185551628'), { promotionCode: 'VIPONLY' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toContain('isn’t available');
  });

  it('stacks a promotion with a loyalty reward without going below zero', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/loyalty-settings`,
      headers: ownerHeaders,
      payload: { enabled: true, pointsPerDollar: 10, rewardPoints: 100, rewardCents: 1800 },
    });
    // A guest with enough points for an $18 reward.
    const callId = await newCall('+15185551629');
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { guestId: true } });
    let guestId = call?.guestId;
    if (!guestId) {
      const guest = await prisma.guest.create({
        data: { tenantId: SEEDED_TENANT, locationId, displayName: 'Rich' },
        select: { id: true },
      });
      guestId = guest.id;
      await prisma.call.update({ where: { id: callId }, data: { guestId } });
    }
    await prisma.loyaltyAccount.upsert({
      where: { guestId },
      create: { tenantId: SEEDED_TENANT, guestId, pointsBalance: 500, lifetimePoints: 500 },
      update: { pointsBalance: 500 },
    });

    // $20 order, $18 reward, then a $5 promotion on top: the promotion is
    // clamped to the $2 left rather than pushing the total negative.
    const res = await placeOrder(callId, { redeemReward: true, promotionCode: 'FIVE-OFF' });
    expect(res.statusCode).toBe(201);
    expect(res.json().totalCents).toBe(0);
    expect(res.json().discountCents).toBe(2000);
    expect(res.json().promotion.discountCents).toBe(200);
  });

  it('will not delete a promotion that has been redeemed', async () => {
    const redeemed = await prisma.promotion.findFirst({ where: { locationId, code: 'FIVE-OFF' } });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/promotions/${redeemed!.id}`,
      headers: ownerHeadersNoBody,
    });
    // Deleting cascades its redemptions and rewrites what past orders were
    // discounted by — retire it instead.
    expect(res.statusCode).toBe(409);
  });

  it('deletes an unredeemed promotion', async () => {
    const created = await createPromo({
      name: 'Never used',
      kind: 'amount_off',
      amountOffCents: 100,
    });
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/promotions/${created.json().id}`,
      headers: ownerHeadersNoBody,
    });
    expect(res.statusCode).toBe(204);
  });

  it('validates a patch against the promotion it produces, not just the fields sent', async () => {
    const created = await createPromo({
      name: 'Switcher',
      kind: 'amount_off',
      amountOffCents: 400,
    });
    // Flipping kind without supplying a percentage would leave it worth nothing.
    const bad = await app.inject({
      method: 'PATCH',
      url: `/v1/promotions/${created.json().id}`,
      headers: ownerHeaders,
      payload: { kind: 'percent_off' },
    });
    expect(bad.statusCode).toBe(422);

    const good = await app.inject({
      method: 'PATCH',
      url: `/v1/promotions/${created.json().id}`,
      headers: ownerHeaders,
      payload: { kind: 'percent_off', percentOff: 15 },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().offer).toBe('15% off');
  });

  it('hides one tenant’s promotions from another', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Promo Outsider' },
      select: { id: true },
    });
    const email = `promo-outsider-${Date.now()}@brayz.test`;
    const user = await prisma.user.create({ data: { email, authSubject: email } });
    await prisma.userTenantMembership.create({
      data: { tenantId: other.id, userId: user.id, role: 'owner' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/promotions`,
      headers: { 'x-brayz-user-email': email, 'x-brayz-tenant-id': other.id },
    });
    expect(res.statusCode).toBe(404);

    await prisma.userTenantMembership.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.tenant.deleteMany({ where: { id: other.id } });
  });
});
