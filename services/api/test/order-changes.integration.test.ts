import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550181';
const CALLER = '+15185552121';
const STRANGER = '+15185552122';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET };

/**
 * "I just ordered — can I add a Coke?"
 *
 * The order a caller may change is their own, at this location, that the
 * kitchen has not accepted. Everything here is about the edges of that
 * sentence: somebody else's order, an order already being cooked, and a change
 * that would break a rule the order was placed under.
 */
describe.skipIf(!dbUp)('Changing an order already placed', () => {
  let app: App;
  let locationId: string;
  let guestId: string;
  let pizzaId: string;
  let cokeId: string;
  const sentSms: Array<{ to: string; body: string }> = [];

  /** A fresh call from `from`, as the voice node creates one. */
  const newCall = async (from = CALLER): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: from, toNumber: TEST_NUMBER },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id;
  };

  /** An order on the books for this guest, as if placed on an earlier call. */
  const placeOrder = async (opts: { status?: string; guest?: string | null } = {}) => {
    const order = await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId,
        guestId: opts.guest === undefined ? guestId : opts.guest,
        fulfillmentType: 'pickup',
        status: opts.status ?? 'confirmed',
        customerName: 'James',
        subtotalCents: 1900,
        totalCents: 1900,
        items: {
          create: [{ menuItemId: pizzaId, name: 'Large Cheese', quantity: 1, unitPriceCents: 1900 }],
        },
      },
      select: { id: true },
    });
    return order.id;
  };

  beforeAll(async () => {
    app = await buildApp({
      notifier: {
        name: 'twilio',
        async sendSms(msg: { to: string; body: string }) {
          sentSms.push(msg);
          return { providerMessageId: 'SM_fake' };
        },
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: TENANT,
        name: 'Order Changes Kitchen',
        timezone: 'America/New_York',
        mainPhone: '+15185550101',
        pickupEnabled: true,
      },
    });
    locationId = location.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, TENANT, locationId, '+15185550101');
    await prisma.phoneNumber.create({ data: { tenantId: TENANT, locationId, e164Number: TEST_NUMBER } });

    const menu = await prisma.menu.create({ data: { tenantId: TENANT, locationId, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Food' } });
    pizzaId = (
      await prisma.menuItem.create({
        data: { categoryId: category.id, name: 'Large Cheese', priceCents: 1900, available: true },
      })
    ).id;
    cokeId = (
      await prisma.menuItem.create({
        data: { categoryId: category.id, name: 'Coke', priceCents: 300, available: true },
      })
    ).id;

    const guest = await prisma.guest.create({
      data: { tenantId: TENANT, locationId, displayName: 'James' },
    });
    guestId = guest.id;
    await prisma.guestPhoneNumber.create({ data: { guestId, tenantId: TENANT, e164: CALLER } });
  });

  afterAll(async () => {
    if (locationId) await alertsCleanup(prisma, locationId);
    if (locationId) {
      await prisma.order.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.guest.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.phoneNumber.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  const lookup = async (callId: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/order/recent`,
      headers: nodeHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  const change = (callId: string, orderId: string, items: unknown[]) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/calls/${callId}/order/${orderId}`,
      headers: nodeHeaders,
      payload: { items },
    });

  it('finds the caller’s own order, with its lines and ids', async () => {
    const orderId = await placeOrder();
    const found = await lookup(await newCall());
    expect(found).toMatchObject({ found: true, needsCode: false, orderId, totalCents: 1900 });
    expect(found.orderCode).toMatch(/^[A-Z0-9]{5}$/);
    // Ids, not just names: the change re-prices every line from the menu.
    expect(found.items[0]).toMatchObject({ menuItemId: pizzaId, name: 'Large Cheese', quantity: 1 });
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('adds the drink they forgot, re-priced from the menu', async () => {
    const orderId = await placeOrder();
    const callId = await newCall();
    const res = await change(callId, orderId, [
      { menuItemId: pizzaId, name: 'Large Cheese', quantity: 1 },
      // The price the caller's side claims is ignored; the menu decides.
      { menuItemId: cokeId, name: 'Coke', quantity: 1, unitPriceCents: 1 },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ totalCents: 2200, posTicket: false });

    const saved = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    // One order, not two — the whole risk of this feature.
    expect(saved?.items).toHaveLength(2);
    expect(saved?.totalCents).toBe(2200);
    expect(await prisma.order.count({ where: { locationId } })).toBe(1);

    // The restaurant is told, and it reads as a change in the first word.
    const text = sentSms.at(-1)!.body;
    expect(text.startsWith('CHANGED —')).toBe(true);
    expect(text).toContain('was $19.00');
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('keeps a discount that was already given', async () => {
    // Placed at $19 of food with $4 taken off; adding a Coke must not quietly
    // withdraw the reward the guest was granted.
    const orderId = await placeOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { totalCents: 1500, discountCents: 400 },
    });
    const callId = await newCall();
    const res = await change(callId, orderId, [
      { menuItemId: pizzaId, name: 'Large Cheese', quantity: 1 },
      { menuItemId: cokeId, name: 'Coke', quantity: 1 },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ subtotalCents: 2200, discountCents: 400, totalCents: 1800 });
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('will not touch an order the kitchen has taken', async () => {
    const orderId = await placeOrder({ status: 'accepted' });
    const callId = await newCall();
    // The lookup says why, so the caller hears "it's already being made"
    // rather than "I can't find it".
    expect(await lookup(callId)).toMatchObject({ found: false, reason: 'locked', status: 'accepted' });
    const res = await change(callId, orderId, [{ menuItemId: cokeId, name: 'Coke', quantity: 1 }]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'order_locked', status: 'accepted' });
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order/${orderId}/cancel`,
      headers: nodeHeaders,
    });
    expect(cancel.statusCode).toBe(409);
    expect(cancel.json().error.code).toBe('order_locked');
    const untouched = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
    expect(untouched?.items).toHaveLength(1);
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('never hands one caller another caller’s order', async () => {
    const orderId = await placeOrder();
    // A different number entirely: no guest, so nothing to find.
    const callId = await newCall(STRANGER);
    expect(await lookup(callId)).toMatchObject({ found: false });
    const res = await change(callId, orderId, [{ menuItemId: cokeId, name: 'Coke', quantity: 1 }]);
    expect(res.statusCode).toBe(404);
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('cancels it, and tells the restaurant', async () => {
    const orderId = await placeOrder();
    const callId = await newCall();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order/${orderId}/cancel`,
      headers: nodeHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'canceled' });
    expect((await prisma.order.findUnique({ where: { id: orderId } }))?.status).toBe('canceled');
    expect(sentSms.at(-1)!.body.startsWith('CANCELED —')).toBe(true);
    // And it cannot be changed afterwards.
    expect(await lookup(callId)).toMatchObject({ found: false, reason: 'locked', status: 'canceled' });
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('says nothing about the order until the code is read back, in confirm mode', async () => {
    await prisma.locationAiSettings.upsert({
      where: { locationId },
      update: { guestMemoryMode: 'confirm' },
      create: { locationId, guestMemoryMode: 'confirm' },
    });
    const orderId = await placeOrder();
    const callId = await newCall();
    const first = await lookup(callId);
    // Only that there is one. Not a line of it, not the total.
    expect(first).toMatchObject({ found: true, needsCode: true, attemptsLeft: 2 });
    expect(first.items).toBeUndefined();
    expect(first.totalCents).toBeUndefined();

    // A change is refused until the caller has proved which order it is.
    const early = await change(callId, orderId, [{ menuItemId: cokeId, name: 'Coke', quantity: 1 }]);
    expect(early.statusCode).toBe(403);

    const confirm = (code: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/calls/${callId}/order/recent/confirm`,
        headers: nodeHeaders,
        payload: { code },
      });
    expect((await confirm('ZZZZZ')).json()).toMatchObject({
      confirmed: false,
      reason: 'mismatch',
      attemptsLeft: 1,
    });

    const { orderCode } = await import('../src/lib/orderMapping.js');
    // Said out loud: spaces and case are not part of the answer.
    const said = orderCode(orderId).split('').join(' ').toLowerCase();
    const ok = await confirm(said);
    expect(ok.json()).toMatchObject({ confirmed: true, found: true, totalCents: 1900 });

    const now = await change(callId, orderId, [
      { menuItemId: pizzaId, name: 'Large Cheese', quantity: 1 },
      { menuItemId: cokeId, name: 'Coke', quantity: 1 },
    ]);
    expect(now.statusCode, now.body).toBe(200);
    await prisma.order.delete({ where: { id: orderId } });
    await prisma.locationAiSettings.update({
      where: { locationId },
      data: { guestMemoryMode: 'full' },
    });
  });

  it('stops looking after two wrong codes, on that call', async () => {
    await prisma.locationAiSettings.update({ where: { locationId }, data: { guestMemoryMode: 'confirm' } });
    const orderId = await placeOrder();
    const callId = await newCall();
    const confirm = (code: string) =>
      app.inject({
        method: 'POST',
        url: `/v1/calls/${callId}/order/recent/confirm`,
        headers: nodeHeaders,
        payload: { code },
      });
    await confirm('AAAAA');
    await confirm('BBBBB');
    expect((await confirm('CCCCC')).json()).toMatchObject({ reason: 'locked', attemptsLeft: 0 });
    // A new call starts fresh — the lock is on the attempt, not the guest.
    expect(await lookup(await newCall())).toMatchObject({ found: true, needsCode: true, attemptsLeft: 2 });
    await prisma.order.delete({ where: { id: orderId } });
    await prisma.locationAiSettings.update({ where: { locationId }, data: { guestMemoryMode: 'full' } });
  });

  it('does not look one up at all when guest memory is off', async () => {
    await prisma.locationAiSettings.update({ where: { locationId }, data: { guestMemoryMode: 'off' } });
    const orderId = await placeOrder();
    expect(await lookup(await newCall())).toMatchObject({ found: false, reason: 'memory_off' });
    await prisma.order.delete({ where: { id: orderId } });
    await prisma.locationAiSettings.update({ where: { locationId }, data: { guestMemoryMode: 'full' } });
  });

  /** Read when a test runs: the menu ids exist only once beforeAll has made them. */
  const pizzaAndCoke = () => [
    { menuItemId: pizzaId, name: 'Large Cheese', quantity: 1 },
    { menuItemId: cokeId, name: 'Coke', quantity: 1 },
  ];

  it('texts every change, even two that come to the same total', async () => {
    const orderId = await placeOrder();
    const callId = await newCall();
    const before = sentSms.length;
    expect((await change(callId, orderId, pizzaAndCoke())).statusCode).toBe(200);
    // Same $22.00, different ticket: the kitchen has to hear about the ice.
    const [pizza, drink] = pizzaAndCoke();
    const noIce = [pizza, { ...drink, specialInstructions: 'No ice' }];
    expect((await change(callId, orderId, noIce)).statusCode).toBe(200);
    expect(sentSms.length - before).toBe(2);
    expect(sentSms.at(-1)!.body).toContain('No ice');
    await prisma.order.delete({ where: { id: orderId } });
  });

  it('moves points with every change, including back to a total the order has had', async () => {
    await prisma.locationLoyaltySettings.upsert({
      where: { locationId },
      create: { locationId, enabled: true, pointsPerDollar: 10 },
      update: { enabled: true, pointsPerDollar: 10 },
    });
    const orderId = await placeOrder();
    const callId = await newCall();
    const pizzaOnly = [pizzaAndCoke()[0]];
    // $19 → $22 → $19 → $22: the order ends $3 up, so 30 points up.
    for (const items of [pizzaAndCoke(), pizzaOnly, pizzaAndCoke()]) {
      expect((await change(callId, orderId, items)).statusCode).toBe(200);
    }
    const events = await prisma.loyaltyEvent.findMany({ where: { orderId } });
    expect(events.map((e) => e.points)).toHaveLength(3);
    expect(events.reduce((sum, e) => sum + e.points, 0)).toBe(30);
    await prisma.loyaltyEvent.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } });
    await prisma.locationLoyaltySettings.update({ where: { locationId }, data: { enabled: false } });
  });

  it('takes a discount off the food only, and gives it all back when food is added back', async () => {
    // $22 of food with $10 off, plus a $3 delivery fee: $15.
    const order = await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId,
        guestId,
        fulfillmentType: 'delivery',
        status: 'confirmed',
        subtotalCents: 2200,
        discountCents: 1000,
        deliveryFeeCents: 300,
        totalCents: 1500,
        items: {
          create: [
            { menuItemId: pizzaId, name: 'Large Cheese', quantity: 1, unitPriceCents: 1900 },
            { menuItemId: cokeId, name: 'Coke', quantity: 1, unitPriceCents: 300 },
          ],
        },
      },
    });
    const callId = await newCall();
    // Down to a $3 Coke: the food is free, the delivery is still $3.
    const coke = await change(callId, order.id, [pizzaAndCoke()[1]]);
    expect(coke.statusCode, coke.body).toBe(200);
    expect(coke.json()).toMatchObject({ discountCents: 300, deliveryFeeCents: 300, totalCents: 300 });
    // The pizza back on: the whole $10 comes off again.
    const back = await change(callId, order.id, pizzaAndCoke());
    expect(back.json()).toMatchObject({ discountCents: 1000, totalCents: 1500 });
    await prisma.order.delete({ where: { id: order.id } });
  });

  it('holds a change to the menu’s option rules', async () => {
    const category = await prisma.menuCategory.findFirstOrThrow({
      where: { menu: { locationId } },
    });
    const wings = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Wings', priceCents: 1200, available: true },
    });
    const sauce = await prisma.modifierGroup.create({
      data: {
        menuItemId: wings.id,
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        maxSelections: 1,
        modifiers: { create: [{ name: 'Hot' }, { name: 'BBQ' }] },
      },
      include: { modifiers: true },
    });
    const [hot, bbq] = sauce.modifiers;
    const halves = await prisma.modifierGroup.create({
      data: {
        menuItemId: pizzaId,
        name: 'Topping',
        selectionType: 'single',
        maxSelections: 1,
        allowsHalves: true,
        modifiers: { create: [{ name: 'Pepperoni' }, { name: 'Sausage' }] },
      },
      include: { modifiers: true },
    });
    const [pepperoni, sausage] = halves.modifiers;
    const orderId = await placeOrder();
    const callId = await newCall();
    const withWings = (modifiers: unknown[]) =>
      change(callId, orderId, [{ menuItemId: wings.id, name: 'Wings', quantity: 1, modifiers }]);

    const noSauce = await withWings([]);
    expect(noSauce.statusCode).toBe(422);
    expect(noSauce.json().error.code).toBe('modifier_required');
    const twoSauces = await withWings([{ id: hot!.id }, { id: bbq!.id }]);
    expect(twoSauces.statusCode).toBe(422);
    expect(twoSauces.json().error.code).toBe('modifier_limit');
    expect((await withWings([{ id: hot!.id }])).statusCode).toBe(200);

    // One topping a side is one topping, as far as the limit goes.
    const halfAndHalf = await change(callId, orderId, [
      {
        menuItemId: pizzaId,
        name: 'Large Cheese',
        quantity: 1,
        modifiers: [
          { id: pepperoni!.id, portion: 'left' },
          { id: sausage!.id, portion: 'right' },
        ],
      },
    ]);
    expect(halfAndHalf.statusCode, halfAndHalf.body).toBe(200);
    await prisma.order.delete({ where: { id: orderId } });
    await prisma.modifierGroup.delete({ where: { id: halves.id } });
    await prisma.menuItem.delete({ where: { id: wings.id } });
  });
});
