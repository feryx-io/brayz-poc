import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PosOrder, PosProvider } from '@brayz/pos';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const OWNER_EMAIL = `halves-owner-${Date.now()}@brayz.test`;
// Unique per test file — halves owns 0144.
const TEST_NUMBER = '+15185550144';

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

/**
 * Half-and-half at the API: the portion is stored on the option row, priced by
 * the group's rule, refused where the group does not allow it, and carried
 * onto the POS line in the option's name.
 */
describe.skipIf(!dbUp)('Half-and-half orders', () => {
  let app: App;
  let callId: string;
  let ownerUserId: string | undefined;
  let locationId: string;
  let pizzaId: string;
  let calzoneId: string;
  let pepId: string;
  let sausId: string;
  let calzPepId: string;
  let pizzaGroupId: string;
  const orderIds: string[] = [];
  const posOrders: PosOrder[] = [];

  const posProvider: PosProvider = {
    name: 'square',
    capabilities: { createOrder: true, updateOrderStatus: false, getMenu: false, syncMenu: false },
    async createOrder(_conn: unknown, order: PosOrder) {
      posOrders.push(order);
      return { externalOrderId: `ext-${posOrders.length}` };
    },
    async updateOrderStatus() {
      throw new Error('unsupported');
    },
    async getMenu() {
      throw new Error('unsupported');
    },
    async syncMenu() {
      throw new Error('unsupported');
    },
  };

  const order = (items: unknown[]) =>
    app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: { items, customerName: 'Jim' },
    });

  beforeAll(async () => {
    app = await buildApp({
      notifier: null,
      posProviders: (provider) => (provider === 'square' ? posProvider : null),
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    // Its own location and menu, so nothing here is disturbed by another file.
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Halves Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    ownerUserId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
    const pos = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: {
        provider: 'square',
        enabled: true,
        externalLocationId: 'SQ-LOC-H',
        accessToken: 'super-secret-token',
        environment: 'sandbox',
      },
    });
    if (pos.statusCode >= 300) throw new Error(`pos setup failed: ${pos.body}`);

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Halves Test Menu', active: true },
      select: { id: true },
    });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza' },
      select: { id: true },
    });
    const categoryId = category.id;
    const pizza = await prisma.menuItem.create({
      data: { categoryId, name: 'Halves Large Pizza', priceCents: 1900 },
      select: { id: true },
    });
    pizzaId = pizza.id;
    const calzone = await prisma.menuItem.create({
      data: { categoryId, name: 'Halves Calzone', priceCents: 1150 },
      select: { id: true },
    });
    calzoneId = calzone.id;

    const pizzaGroup = await prisma.modifierGroup.create({
      data: { menuItemId: pizzaId, name: 'Toppings', selectionType: 'multi', allowsHalves: true },
    });
    pizzaGroupId = pizzaGroup.id;
    pepId = (await prisma.modifier.create({
      data: { modifierGroupId: pizzaGroupId, name: 'Pepperoni', priceCents: 150 },
    })).id;
    sausId = (await prisma.modifier.create({
      data: { modifierGroupId: pizzaGroupId, name: 'Sausage', priceCents: 150 },
    })).id;
    const calzGroup = await prisma.modifierGroup.create({
      data: { menuItemId: calzoneId, name: 'Toppings', selectionType: 'multi', allowsHalves: false },
    });
    calzPepId = (await prisma.modifier.create({
      data: { modifierGroupId: calzGroup.id, name: 'Pepperoni', priceCents: 100 },
    })).id;

    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551818', toNumber: TEST_NUMBER },
    });
    callId = create.json().id;
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
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (ownerUserId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: ownerUserId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: ownerUserId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('serves the group flags to the bot with the menu', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu`,
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string; modifierGroups: Array<Record<string, unknown>> }>;
    const pizza = items.find((i) => i.name === 'Halves Large Pizza')!;
    expect(pizza.modifierGroups[0]).toMatchObject({ allowsHalves: true, halfPricing: 'full' });
    const calzone = items.find((i) => i.name === 'Halves Calzone')!;
    expect(calzone.modifierGroups[0]).toMatchObject({ allowsHalves: false });
  });

  it('stores each half with its portion, priced in full, and names it on the POS line', async () => {
    posOrders.length = 0;
    const res = await order([
      {
        menuItemId: pizzaId,
        name: 'Halves Large Pizza',
        quantity: 1,
        modifiers: [
          { id: pepId, portion: 'left' },
          { id: sausId, portion: 'right' },
        ],
      },
    ]);
    expect(res.statusCode).toBe(201);
    orderIds.push(res.json().id);
    expect(res.json().totalCents).toBe(1900 + 150 + 150);

    const rows = await prisma.orderItemModifier.findMany({
      where: { orderItem: { orderId: res.json().id } },
      orderBy: { name: 'asc' },
      select: { name: true, priceCents: true, portion: true },
    });
    expect(rows).toEqual([
      { name: 'Pepperoni', priceCents: 150, portion: 'left' },
      { name: 'Sausage', priceCents: 150, portion: 'right' },
    ]);

    // The kitchen reads the POS line; the half has to be in the words.
    expect(posOrders).toHaveLength(1);
    expect(posOrders[0]!.lines[0]!.modifiers?.map((m) => m.name)).toEqual([
      'Pepperoni (left half)',
      'Sausage (right half)',
    ]);
  });

  it('prices a half at half when the group says so', async () => {
    await prisma.modifierGroup.update({ where: { id: pizzaGroupId }, data: { halfPricing: 'half' } });
    const res = await order([
      {
        menuItemId: pizzaId,
        name: 'Halves Large Pizza',
        quantity: 2,
        modifiers: [
          { id: pepId, portion: 'left' },
          { id: sausId }, // whole, by default
        ],
      },
    ]);
    expect(res.statusCode).toBe(201);
    orderIds.push(res.json().id);
    // Per pizza: 1900 + 75 (half pepperoni) + 150 (whole sausage); two pizzas.
    expect(res.json().totalCents).toBe(2 * (1900 + 75 + 150));
    await prisma.modifierGroup.update({ where: { id: pizzaGroupId }, data: { halfPricing: 'full' } });
  });

  it('refuses a half on an item whose group does not allow it', async () => {
    const res = await order([
      {
        menuItemId: calzoneId,
        name: 'Halves Calzone',
        modifiers: [{ id: calzPepId, portion: 'left' }],
      },
    ]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('half_not_allowed');
  });

  it('still accepts the older modifierIds form as whole options', async () => {
    const res = await order([
      { menuItemId: pizzaId, name: 'Halves Large Pizza', modifierIds: [pepId] },
    ]);
    expect(res.statusCode).toBe(201);
    orderIds.push(res.json().id);
    const rows = await prisma.orderItemModifier.findMany({
      where: { orderItem: { orderId: res.json().id } },
      select: { name: true, portion: true },
    });
    expect(rows).toEqual([{ name: 'Pepperoni', portion: 'whole' }]);
  });

  it('shows the portion on the order the dashboard reads', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/orders`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ id: string; items: Array<{ modifiers: Array<{ portion: string }> }> }>;
    const first = (Array.isArray(rows) ? rows : (rows as { orders: typeof rows }).orders).find(
      (o) => o.id === orderIds[0],
    )!;
    const mods = first.items[0]!.modifiers;
    expect(mods.map((m) => m.portion).sort()).toEqual(['left', 'right']);
  });

  it('defaults a new toppings group on a pizza to allow halves, and one on a calzone not to', async () => {
    const onPizza = await app.inject({
      method: 'POST',
      url: `/v1/menu/items/${pizzaId}/modifier-groups`,
      headers: ownerHeaders,
      payload: { name: 'Extra Toppings', selectionType: 'multi' },
    });
    expect(onPizza.statusCode).toBe(201);
    expect(onPizza.json().allowsHalves).toBe(true);
    const onCalzone = await app.inject({
      method: 'POST',
      url: `/v1/menu/items/${calzoneId}/modifier-groups`,
      headers: ownerHeaders,
      payload: { name: 'Extra Toppings', selectionType: 'multi' },
    });
    expect(onCalzone.statusCode).toBe(201);
    expect(onCalzone.json().allowsHalves).toBe(false);
    // Said outright, the editor's choice wins.
    const flipped = await app.inject({
      method: 'PATCH',
      url: `/v1/menu/modifier-groups/${onCalzone.json().id}`,
      headers: ownerHeaders,
      payload: { allowsHalves: true, halfPricing: 'half' },
    });
    expect(flipped.statusCode).toBe(200);
    expect(flipped.json()).toMatchObject({ allowsHalves: true, halfPricing: 'half' });
  });
});
