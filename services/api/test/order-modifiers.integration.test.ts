import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique to this file. It was 0131, which pos.integration.test.ts also claimed:
// both delete every row for the number and recreate it pointing at their own
// location, so whichever ran second silently took the other's calls and the
// loser's order 422'd on a menu item that belonged to a location it was no
// longer calling. See numbers.test.ts, which now fails on a duplicate.
const TEST_NUMBER = '+15185550138';

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

/**
 * Options on an order line (crust, toppings, sauce). They were modeled in the
 * schema and editable in the menu editor from Phase 1, but the ordering path
 * never wrote one: a caller's "garlic parm, boneless" landed in free text, so a
 * paid option was never charged and never reached a POS ticket as a line.
 */
describe.skipIf(!dbUp)('Order line options', () => {
  let app: App;
  let locationId: string;
  let callId: string;
  let itemId: string;
  let itemName: string;
  let itemPriceCents: number;
  let groupId: string;
  let freeOptionId: string;
  let paidOptionId: string;
  let paidOptionCents: number;
  let offMenuOptionId: string;
  let otherGroupId: string;
  const orderIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    // A location and menu of its own. The groups below include a REQUIRED
    // one, and the API refuses an order that skips a required choice — so
    // hanging them on the shared seeded menu failed every other test file
    // that orders a plain seeded item while this one was running.
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Order Options Kitchen', pickupEnabled: true },
    });
    locationId = location.id;
    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, active: true },
    });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Food' } });
    await prisma.menuItem.createMany({
      data: [
        { categoryId: category.id, name: 'Boneless Wings', priceCents: 1100 },
        { categoryId: category.id, name: 'Cheese Pizza', priceCents: 1500 },
      ],
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551414', toNumber: TEST_NUMBER },
    });
    callId = create.json().id;

    const items = await prisma.menuItem.findMany({
      where: { available: true, category: { menu: { locationId, active: true } } },
      orderBy: { name: 'asc' },
      take: 2,
      select: { id: true, name: true, priceCents: true },
    });
    if (items.length < 2) throw new Error('menu needs two items');
    itemId = items[0]!.id;
    itemName = items[0]!.name;
    itemPriceCents = items[0]!.priceCents;

    const group = await prisma.modifierGroup.create({
      data: { menuItemId: itemId, name: 'Wing sauce', selectionType: 'single', required: true },
    });
    groupId = group.id;
    const free = await prisma.modifier.create({
      data: { modifierGroupId: groupId, name: 'Mild', priceCents: 0 },
    });
    freeOptionId = free.id;
    const paid = await prisma.modifier.create({
      data: { modifierGroupId: groupId, name: 'Garlic Parm', priceCents: 125 },
    });
    paidOptionId = paid.id;
    paidOptionCents = paid.priceCents;
    const off = await prisma.modifier.create({
      data: { modifierGroupId: groupId, name: 'Discontinued Sauce', priceCents: 100, available: false },
    });
    offMenuOptionId = off.id;

    // A group on a DIFFERENT item, to prove an option cannot travel.
    const other = await prisma.modifierGroup.create({
      data: { menuItemId: items[1]!.id, name: 'Crust', selectionType: 'single' },
    });
    otherGroupId = other.id;
    await prisma.modifier.create({
      data: { modifierGroupId: otherGroupId, name: 'Thin crust', priceCents: 200 },
    });
  });

  afterAll(async () => {
    for (const id of orderIds) {
      await prisma.notification.deleteMany({ where: { dedupeKey: `order-confirmed:${id}` } }).catch(() => {});
      await prisma.order.deleteMany({ where: { id } }).catch(() => {});
    }
    if (callId) {
      await prisma.order.deleteMany({ where: { callId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    }
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    // The menu, its groups and options go with the location.
    if (locationId) await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('prices each option from the menu and stores it as its own row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [
          {
            menuItemId: itemId,
            name: itemName,
            quantity: 2,
            modifierIds: [paidOptionId, freeOptionId],
          },
        ],
        customerName: 'Dana',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; totalCents: number };
    orderIds.push(body.id);

    // An option is priced per unit of the line: two orders of wings is two
    // lots of garlic parm.
    expect(body.totalCents).toBe((itemPriceCents + paidOptionCents) * 2);

    const stored = await prisma.orderItem.findMany({
      where: { orderId: body.id },
      include: { modifiers: { orderBy: { name: 'asc' } } },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.modifiers.map((m) => [m.name, m.priceCents])).toEqual([
      ['Garlic Parm', 125],
      ['Mild', 0],
    ]);
    // Each row points back at the menu option it came from, so a report can
    // count how often an option is chosen.
    expect(stored[0]!.modifiers.every((m) => m.modifierId !== null)).toBe(true);
  });

  it('refuses an option that belongs to a different item', async () => {
    const foreign = await prisma.modifier.findFirst({ where: { modifierGroupId: otherGroupId } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId: itemId, name: itemName, quantity: 1, modifierIds: [foreign!.id] }],
      },
    });
    // Failing the order is the point: the caller asked for something, and a
    // silently dropped option reaches the kitchen as a wrong ticket.
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('modifier_unavailable');
  });

  it('refuses an option the restaurant has turned off', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId: itemId, name: itemName, quantity: 1, modifierIds: [offMenuOptionId] }],
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('modifier_unavailable');
  });
});
