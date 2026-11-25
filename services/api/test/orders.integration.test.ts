import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550125';
const CALLER = '+15185551326';

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
const userHeaders = { 'x-brayz-user-email': 'orders-owner@brayz.test', 'x-brayz-tenant-id': SEEDED_TENANT };
const NOTIFY_NUMBER = '+15185559999';

describe.skipIf(!dbUp)('Orders API (node place + tenant-scoped read)', () => {
  let app: App;
  let locationId: string;
  let callId: string;
  let menuItemId: string;
  let menuItemName: string;
  let unitPriceCents: number;
  let orderId: string | undefined;
  const sentSms: Array<{ to: string; from?: string; body: string }> = [];

  beforeAll(async () => {
    const fakeNotifier = {
      // Named for the carrier so the location's own number is the sender.
      name: 'twilio',
      async sendSms(msg: { to: string; from?: string; body: string }) {
        sentSms.push(msg);
        return { providerMessageId: 'SM_fake' };
      },
    };
    app = await buildApp({ notifier: fakeNotifier });
    // A location of its own, with one line and one menu item. On the shared
    // seeded location two things raced other test files running alongside:
    // the text goes out from the location's OLDEST line, usually another
    // file's number, which that file could delete mid-assertion; and any file
    // hanging a required option group on a seeded item made this order 422.
    const location = await prisma.location.create({
      data: {
        tenantId: SEEDED_TENANT,
        name: 'Orders API Kitchen',
        pickupEnabled: true,
        // The restaurant's SMS destination for order texts.
        notificationPhone: NOTIFY_NUMBER,
      },
    });
    locationId = location.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, SEEDED_TENANT, locationId, NOTIFY_NUMBER);
    const menu = await prisma.menu.create({ data: { tenantId: SEEDED_TENANT, locationId, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' } });
    await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large Cheese Pizza', priceCents: 1799 },
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      // A caller number no other suite uses. Guests are per tenant by phone, so
      // a shared number is a shared guest — and closed-hours, which called from
      // this one too, deletes its guests while this order may still be placing.
      payload: { provider: 'twilio', fromNumber: CALLER, toNumber: TEST_NUMBER },
    });
    callId = create.json().id;

    const item = await prisma.menuItem.findFirst({
      where: { available: true, category: { menu: { locationId, active: true } } },
      select: { id: true, name: true, priceCents: true },
    });
    if (!item) throw new Error('menu item missing');
    menuItemId = item.id;
    menuItemName = item.name;
    unitPriceCents = item.priceCents;
  });

  afterAll(async () => {
    if (locationId) await alertsCleanup(prisma, locationId);
    if (orderId) {
      await prisma.notification.deleteMany({ where: { dedupeKey: `order-confirmed:${orderId}` } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id: orderId } }).catch(() => {});
    }
    // callId can be undefined if beforeAll failed; Prisma ignores undefined
    // where-fields, so an unguarded deleteMany would wipe the whole table.
    if (callId) {
      await prisma.order.deleteMany({ where: { callId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    }
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects placing an order without the node secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: { 'content-type': 'application/json' },
      payload: { items: [{ menuItemId, name: menuItemName, quantity: 1 }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('places an order, re-pricing each line from the menu (ignores any client price)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId, name: 'BOGUS NAME', quantity: 2, specialInstructions: 'extra cheese' }],
        customerName: 'Sam',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; orderCode: string; totalCents: number };
    orderId = body.id;
    // Total comes from the menu, not the request (which carried a bogus name + no price).
    expect(body.totalCents).toBe(unitPriceCents * 2);
    expect(body.orderCode).toMatch(/^[0-9A-F]{5}$/);

    const order = await prisma.order.findUnique({ where: { id: body.id }, include: { items: true } });
    expect(order?.status).toBe('confirmed');
    expect(order?.customerName).toBe('Sam');
    expect(order?.customerPhone).toBe(CALLER); // taken from the call's fromNumber
    expect(order?.items).toHaveLength(1);
    expect(order?.items[0]).toMatchObject({
      name: menuItemName, // authoritative name, not 'BOGUS NAME'
      quantity: 2,
      unitPriceCents,
      specialInstructions: 'extra cheese',
    });

    // The restaurant was texted, and the attempt was recorded as a Notification.
    expect(sentSms).toHaveLength(1);
    expect(sentSms[0].to).toBe(NOTIFY_NUMBER);
    // From the restaurant's own line, not some global number.
    expect(sentSms[0]!.from).toBe(TEST_NUMBER);
    expect(sentSms[0].body).toContain(`#${body.orderCode}`);
    expect(sentSms[0].body).toContain(menuItemName);
    const notif = await prisma.notification.findUnique({
      where: { dedupeKey: `order-confirmed:${body.id}` },
    });
    expect(notif?.status).toBe('sent');
    expect(notif?.recipient).toBe(NOTIFY_NUMBER);
  });

  it('422s when an item is not on the call location menu', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId: '99999999-9999-9999-9999-999999999999', name: 'Ghost', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(422);
  });

  it('lists the order for the location (user-authed, tenant-scoped)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/orders`,
      headers: userHeaders,
    });
    expect(res.statusCode).toBe(200);
    const orders = res.json() as Array<{ id: string; code: string; totalCents: number; items: unknown[] }>;
    const mine = orders.find((o) => o.id === orderId);
    expect(mine).toBeTruthy();
    expect(mine!.code).toMatch(/^[0-9A-F]{5}$/);
    expect(mine!.items).toHaveLength(1);
  });
});
