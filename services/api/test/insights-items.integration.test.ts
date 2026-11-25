import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const TZ = 'America/New_York';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const userHeaders = { 'x-brayz-user-email': 'menu-insights@brayz.test', 'x-brayz-tenant-id': TENANT };

/** Monday 2026-09-07 00:00 EDT → Monday 2026-09-14 00:00 EDT. */
const FROM = '2026-09-07T04:00:00.000Z';
const TO = '2026-09-14T04:00:00.000Z';

/**
 * What every item on the menu did — including the ones that did nothing.
 *
 * The point of this view is the item with no sales, which by definition has no
 * order rows to be counted from. So the fixture keeps four kinds of item side
 * by side: one that sells, one that sold only before this window, one that has
 * never sold at all, and one that is hidden from the AI entirely.
 */
describe.skipIf(!dbUp)('Insights — every menu item', () => {
  let app: App;
  let locationId: string | undefined;

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const location = await prisma.location.create({
      data: { tenantId: TENANT, name: 'Menu Insights Kitchen', timezone: TZ },
    });
    locationId = location.id;

    const menu = await prisma.menu.create({
      data: { tenantId: TENANT, locationId: location.id, active: true },
    });
    const pizzas = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza', sortOrder: 0 },
    });
    const salads = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Salads', sortOrder: 1 },
    });

    const seller = await prisma.menuItem.create({
      data: { categoryId: pizzas.id, name: 'Large Cheese', priceCents: 1000, available: true },
    });
    // Sold, but only before the window opened.
    const lapsed = await prisma.menuItem.create({
      data: { categoryId: pizzas.id, name: 'Hawaiian', priceCents: 1400, available: true },
    });
    // On the menu since the day it opened, never once ordered.
    await prisma.menuItem.create({
      data: { categoryId: salads.id, name: 'Beet Salad', priceCents: 900, available: true },
    });
    // Hidden from the AI, so it cannot sell — a different problem entirely.
    await prisma.menuItem.create({
      data: { categoryId: salads.id, name: 'Winter Salad', priceCents: 1100, available: false },
    });
    // Taken off the menu after it sold: the money was still taken.
    const retired = await prisma.menuItem.create({
      data: { categoryId: pizzas.id, name: 'Retired Special', priceCents: 1600, available: true },
    });

    // What gets chosen on the pizza: two questions, which must not be read as
    // one list — a topping and a crust are not the same kind of answer.
    const toppings = await prisma.modifierGroup.create({
      data: { menuItemId: seller.id, name: 'Toppings', selectionType: 'multi', required: false },
    });
    const crust = await prisma.modifierGroup.create({
      data: { menuItemId: seller.id, name: 'Crust', selectionType: 'single', required: true },
    });
    const pepperoni = await prisma.modifier.create({
      data: { modifierGroupId: toppings.id, name: 'Pepperoni', priceCents: 200 },
    });
    await prisma.modifier.create({
      data: { modifierGroupId: toppings.id, name: 'Sausage', priceCents: 200 },
    });
    const thin = await prisma.modifier.create({
      data: { modifierGroupId: crust.id, name: 'Thin', priceCents: 0 },
    });

    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        fulfillmentType: 'pickup',
        status: 'confirmed',
        subtotalCents: 3000,
        totalCents: 3000,
        createdAt: new Date('2026-09-11T18:40:00Z'),
        items: {
          create: [
            // Two lines of the same item: the count must add them up.
            {
              menuItemId: seller.id,
              name: 'Large Cheese',
              quantity: 2,
              unitPriceCents: 1000,
              // Two pizzas with pepperoni is two pepperonis, not one.
              modifiers: { create: [{ modifierId: pepperoni.id, name: 'Pepperoni', priceCents: 200 }] },
            },
            {
              menuItemId: seller.id,
              name: 'Large Cheese',
              quantity: 1,
              unitPriceCents: 900,
              modifiers: {
                create: [
                  { modifierId: pepperoni.id, name: 'Pepperoni', priceCents: 200 },
                  { modifierId: thin.id, name: 'Thin', priceCents: 0 },
                  // Asked for out loud, never on the menu: kept, under "Other".
                  { name: 'Extra crispy', priceCents: 0 },
                ],
              },
            },
            { menuItemId: retired.id, name: 'Retired Special', quantity: 1, unitPriceCents: 1600 },
            // No menu item at all — a line the menu could not price.
            { name: 'Off-menu special', quantity: 1, unitPriceCents: 500 },
          ],
        },
      },
    });
    // Before the window: makes Hawaiian "sold nothing lately" rather than "never".
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        fulfillmentType: 'pickup',
        status: 'confirmed',
        subtotalCents: 1400,
        totalCents: 1400,
        createdAt: new Date('2026-08-20T18:00:00Z'),
        items: { create: [{ menuItemId: lapsed.id, name: 'Hawaiian', quantity: 1, unitPriceCents: 1400 }] },
      },
    });
    // Canceled inside the window: counts for nothing, anywhere.
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        fulfillmentType: 'pickup',
        status: 'canceled',
        subtotalCents: 9000,
        totalCents: 9000,
        createdAt: new Date('2026-09-11T19:00:00Z'),
        items: { create: [{ menuItemId: seller.id, name: 'Large Cheese', quantity: 9, unitPriceCents: 1000 }] },
      },
    });

    // Retire the special: its sale stays, its menu row goes.
    await prisma.menuItem.delete({ where: { id: retired.id } });
  });

  afterAll(async () => {
    if (locationId) {
      await prisma.order.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  const read = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights/items?from=${FROM}&to=${TO}&tz=${TZ}`,
      headers: userHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  type Item = {
    name: string;
    category: string;
    quantity: number;
    orderLines: number;
    revenueCents: number;
    available: boolean;
    lastOrderedAt: string | null;
  };
  const find = (d: { items: Item[] }, name: string) => d.items.find((i) => i.name === name) as Item;

  it('adds up the lines of an item that sells, at the price charged', async () => {
    const d = await read();
    const seller = find(d, 'Large Cheese');
    // Two lines, three units, and the second line was discounted to 900 — the
    // takings are what was charged, not three times today's price.
    expect(seller).toMatchObject({ quantity: 3, orderLines: 2, revenueCents: 2900, category: 'Pizza' });
    expect(seller.lastOrderedAt).not.toBeNull();
  });

  it('says what was chosen on the item, kept in the groups the menu asks', async () => {
    const d = await read();
    const groups = (find(d, 'Large Cheese') as unknown as {
      optionGroups: Array<{ name: string; options: Array<{ name: string; quantity: number }> }>;
    }).optionGroups;
    const byName = Object.fromEntries(groups.map((g) => [g.name, g.options]));
    // Three pizzas, all three with pepperoni — counted by the line's quantity,
    // so two pizzas on one line are two pepperonis.
    expect(byName.Toppings).toEqual([{ name: 'Pepperoni', quantity: 3 }]);
    // A crust is a different question from a topping and is never folded in.
    expect(byName.Crust).toEqual([{ name: 'Thin', quantity: 1 }]);
    // Asked for out loud and never on the menu: kept rather than dropped.
    expect(byName.Other).toEqual([{ name: 'Extra crispy', quantity: 1 }]);
    // An item nobody ordered has nothing chosen on it, and says so plainly.
    expect((find(d, 'Beet Salad') as unknown as { optionGroups: unknown[] }).optionGroups).toEqual([]);
  });

  it('exports the items as a spreadsheet, off-menu sales included and marked', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights/items.csv?from=${FROM}&to=${TO}&tz=${TZ}`,
      headers: userHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('menu-items-menu-insights-kitchen');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('category,item,menu_price,on_menu,available,quantity,order_lines,revenue,last_ordered');
    // Money as a plain number, so a spreadsheet adds it up rather than reading text.
    expect(lines.find((l) => l.startsWith('Pizza,Large Cheese'))).toContain(',3,2,29.00,');
    // Sold but no longer on the menu: still in the file, marked as off it.
    expect(lines.some((l) => l.startsWith(',Retired Special,,no,'))).toBe(true);
    expect(lines.some((l) => l.startsWith(',Off-menu special,,no,'))).toBe(true);
  });

  it('exports what was chosen as its own spreadsheet, with the share of the item', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights/item-options.csv?from=${FROM}&to=${TO}&tz=${TZ}`,
      headers: userHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe('category,item,option_group,option,quantity,share_of_item');
    // Three of the three pizzas had it.
    expect(lines).toContain('Pizza,Large Cheese,Toppings,Pepperoni,3,100%');
    expect(lines).toContain('Pizza,Large Cheese,Crust,Thin,1,33%');
  });

  it('shows an item that sold nothing, which is the whole point', async () => {
    const d = await read();
    // Never ordered at all: on the menu, invisible in every order table.
    expect(find(d, 'Beet Salad')).toMatchObject({ quantity: 0, revenueCents: 0, lastOrderedAt: null });
    // Sold once, but before this window: not "never", which is a different fact.
    const lapsed = find(d, 'Hawaiian');
    expect(lapsed.quantity).toBe(0);
    expect(lapsed.lastOrderedAt?.slice(0, 10)).toBe('2026-08-20');
  });

  it('marks an item the AI is not allowed to offer', async () => {
    const d = await read();
    // It cannot sell while it is hidden, which is not the same as unwanted.
    expect(find(d, 'Winter Salad')).toMatchObject({ available: false, quantity: 0 });
  });

  it('keeps what sold but is no longer on the menu', async () => {
    const d = await read();
    expect(d.items.map((i: Item) => i.name)).not.toContain('Retired Special');
    const names = d.offMenu.map((o: { name: string }) => o.name);
    expect(names).toContain('Retired Special');
    expect(names).toContain('Off-menu special');
    expect(d.offMenu.find((o: { name: string }) => o.name === 'Retired Special')).toMatchObject({
      quantity: 1,
      revenueCents: 1600,
    });
  });

  it('counts a canceled order for nothing', async () => {
    const d = await read();
    // The canceled order asked for nine of these.
    expect(find(d, 'Large Cheese').quantity).toBe(3);
  });

  it('totals what is on the menu, and how much of it earns nothing', async () => {
    const d = await read();
    expect(d.totals).toMatchObject({
      onMenu: 4,
      // Hawaiian, Beet Salad and Winter Salad sold nothing in the window.
      unsoldInWindow: 3,
      // Only Beet Salad and Winter Salad have never sold at all.
      neverOrdered: 2,
      quantity: 3,
      revenueCents: 2900,
    });
  });

  it('refuses a timezone it does not know, and another tenant’s location', async () => {
    const badTz = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights/items?tz=Mars/Olympus`,
      headers: userHeaders,
    });
    expect(badTz.statusCode).toBe(400);
    expect(badTz.json().error.code).toBe('bad_timezone');

    const stranger = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights/items`,
      headers: { 'x-brayz-user-email': 'stranger@brayz.test', 'x-brayz-tenant-id': '00000000-0000-0000-0000-0000000000ff' },
    });
    expect([401, 403, 404]).toContain(stranger.statusCode);
  });
});
