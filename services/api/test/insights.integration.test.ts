import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
// Its own location: test files run in parallel against one database, and this
// one owns its calls, orders and opening hours.
const TZ = 'America/New_York';
const CALLER_A = '+15185554901';
const CALLER_B = '+15185554902';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const userHeaders = { 'x-brayz-user-email': 'insights-owner@brayz.test', 'x-brayz-tenant-id': TENANT };

/** Monday 2026-09-07 00:00 EDT → Monday 2026-09-14 00:00 EDT. */
const FROM = '2026-09-07T04:00:00.000Z';
const TO = '2026-09-14T04:00:00.000Z';

describe.skipIf(!dbUp)('Insights (what Brayz did for one restaurant)', () => {
  let app: App;
  let locationId: string | undefined;
  let guestReturning: string;
  let guestNew: string;

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const location = await prisma.location.create({
      data: { tenantId: TENANT, name: 'Insights Test Kitchen', timezone: TZ },
    });
    locationId = location.id;
    // Open 11:00–22:00 every day, so 02:00 is plainly after hours.
    await prisma.locationHours.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
        locationId: location.id,
        dayOfWeek,
        opensAt: 11 * 60,
        closesAt: 22 * 60,
      })),
    });

    const menu = await prisma.menu.create({ data: { tenantId: TENANT, locationId: location.id, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' } });
    const pizza = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large Cheese', priceCents: 1000, available: true },
    });
    const knots = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Garlic Knots', priceCents: 600, available: true },
    });
    // Wings as a real menu carries them: a sauce to choose and a dip beside it,
    // two groups, which is what the breakdown has to keep apart.
    const wings = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Boneless Wings', priceCents: 1250, available: true },
    });
    const sauceGroup = await prisma.modifierGroup.create({
      data: { menuItemId: wings.id, name: 'Sauce', selectionType: 'single', required: true },
    });
    const dipGroup = await prisma.modifierGroup.create({
      data: { menuItemId: wings.id, name: 'Dip', selectionType: 'single', required: false },
    });
    const mild = await prisma.modifier.create({
      data: { modifierGroupId: sauceGroup.id, name: 'Buffalo (Mild)', priceCents: 0 },
    });
    await prisma.modifier.create({
      data: { modifierGroupId: sauceGroup.id, name: 'BBQ', priceCents: 0 },
    });
    const ranch = await prisma.modifier.create({
      data: { modifierGroupId: dipGroup.id, name: 'Ranch', priceCents: 0 },
    });

    const returning = await prisma.guest.create({
      data: { tenantId: TENANT, locationId: location.id, displayName: 'Regular Rita' },
    });
    const fresh = await prisma.guest.create({
      data: { tenantId: TENANT, locationId: location.id, displayName: 'First-time Fred' },
    });
    guestReturning = returning.id;
    guestNew = fresh.id;
    await prisma.guestPhoneNumber.createMany({
      data: [
        { guestId: returning.id, tenantId: TENANT, e164: CALLER_A },
        { guestId: fresh.id, tenantId: TENANT, e164: CALLER_B },
      ],
    });

    const call = (startISO: string, minutes: number | null) => ({
      tenantId: TENANT,
      locationId: location.id,
      status: 'completed',
      startedAt: new Date(startISO),
      endedAt: minutes === null ? null : new Date(new Date(startISO).getTime() + minutes * 60_000),
    });
    await prisma.call.createMany({
      data: [
        // Friday 14:30 local — open, and answered anyway.
        call('2026-09-11T18:30:00Z', 5),
        // Friday 02:00 local — shut. This one would have rung out.
        call('2026-09-11T06:00:00Z', 2),
        // Friday 14:31 local — the first call is still on the line.
        call('2026-09-11T18:31:00Z', 2),
      ],
    });

    // Friday 14:40 local: pickup, with one line the bot upsold.
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        guestId: returning.id,
        fulfillmentType: 'pickup',
        status: 'confirmed',
        subtotalCents: 2600,
        totalCents: 2600,
        createdAt: new Date('2026-09-11T18:40:00Z'),
        items: {
          create: [
            { menuItemId: pizza.id, name: 'Large Cheese', quantity: 2, unitPriceCents: 1000 },
            { menuItemId: knots.id, name: 'Garlic Knots', quantity: 1, unitPriceCents: 600, viaUpsell: true },
            // Two wings on one line, with a sauce, a dip, and a request the
            // menu cannot price. The breakdown must count them by the line's
            // quantity (two of each, not one), keep the sauce and the dip
            // apart, and still show the ad-hoc one rather than dropping it.
            {
              menuItemId: wings.id,
              name: 'Boneless Wings',
              quantity: 2,
              unitPriceCents: 1250,
              modifiers: {
                create: [
                  { modifierId: mild.id, name: 'Buffalo (Mild)', priceCents: 0 },
                  { modifierId: ranch.id, name: 'Ranch', priceCents: 0 },
                  { name: 'Extra crispy', priceCents: 0 },
                ],
              },
            },
          ],
        },
      },
    });
    // Friday 20:00 local — the same local day as the one above, a different UTC one.
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        guestId: fresh.id,
        fulfillmentType: 'delivery',
        status: 'confirmed',
        subtotalCents: 1000,
        deliveryFeeCents: 100,
        totalCents: 1100,
        createdAt: new Date('2026-09-12T00:00:00Z'),
        items: { create: [{ menuItemId: pizza.id, name: 'Large Cheese', quantity: 1, unitPriceCents: 1000 }] },
      },
    });
    // Before the window: what makes Rita a returning guest rather than a new one.
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        guestId: returning.id,
        fulfillmentType: 'pickup',
        status: 'confirmed',
        subtotalCents: 900,
        totalCents: 900,
        createdAt: new Date('2026-09-01T18:00:00Z'),
        items: { create: [{ menuItemId: pizza.id, name: 'Large Cheese', quantity: 1, unitPriceCents: 900 }] },
      },
    });
    // Canceled in the window: never revenue.
    await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: location.id,
        fulfillmentType: 'pickup',
        status: 'canceled',
        subtotalCents: 5000,
        totalCents: 5000,
        createdAt: new Date('2026-09-11T19:00:00Z'),
        items: { create: [{ menuItemId: pizza.id, name: 'Large Cheese', quantity: 5, unitPriceCents: 1000 }] },
      },
    });
  });

  afterAll(async () => {
    if (locationId) {
      await prisma.order.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.guest.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  const read = async (query = '') => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights?from=${FROM}&to=${TO}&tz=${TZ}${query}`,
      headers: userHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  it('counts the calls that would have rung out, and says why', async () => {
    const d = await read();
    expect(d.calls).toMatchObject({
      answered: 3,
      afterHours: 1,
      whileAnotherCallWasLive: 1,
      wouldHaveRungOut: 2,
      hoursKnown: true,
    });
  });

  it('adds up orders the way the guest was charged, and leaves a canceled one out', async () => {
    const d = await read();
    expect(d.orders).toMatchObject({
      count: 2,
      revenueCents: 3700,
      averageCents: 1850,
      deliveryFeeCents: 100,
      discountCents: 0,
    });
    const byType = Object.fromEntries(d.orders.byFulfillment.map((f: { type: string }) => [f.type, f]));
    expect(byType.pickup).toMatchObject({ count: 1, revenueCents: 2600 });
    expect(byType.delivery).toMatchObject({ count: 1, revenueCents: 1100 });
  });

  it('credits the bot with what it upsold, priced from the stored line', async () => {
    const d = await read();
    expect(d.upsell).toEqual({ items: 1, revenueCents: 600 });
  });

  it('separates a guest who came back from one who was new', async () => {
    const d = await read();
    expect(d.guests).toMatchObject({ ordering: 2, returning: 1, new: 1 });
    const names = d.guests.top.map((g: { name: string }) => g.name);
    expect(names).toContain('Regular Rita');
    expect(names).toContain('First-time Fred');
    const rita = d.guests.top.find((g: { id: string }) => g.id === guestReturning);
    expect(rita).toMatchObject({ orders: 1, spentCents: 2600 });
    expect(d.guests.top.find((g: { id: string }) => g.id === guestNew)).toMatchObject({ spentCents: 1100 });
  });

  it('counts a guest who first ordered inside the window and came back inside it', async () => {
    // The split cannot be measured against the window's start alone: a
    // restaurant reading its first month would see every regular as new.
    const second = await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId: locationId!,
        guestId: guestNew,
        fulfillmentType: 'pickup',
        status: 'confirmed',
        subtotalCents: 1000,
        totalCents: 1000,
        createdAt: new Date('2026-09-13T00:00:00Z'),
      },
    });
    try {
      const d = await read();
      expect(d.guests).toMatchObject({ ordering: 2, returning: 2, new: 0 });
    } finally {
      await prisma.order.delete({ where: { id: second.id } });
    }
  });

  it('ranks the items actually ordered', async () => {
    const d = await read();
    expect(d.items[0]).toMatchObject({ name: 'Large Cheese', quantity: 3 });
    expect(d.items.map((i: { name: string }) => i.name)).toContain('Garlic Knots');
  });

  it('breaks an item down by group, counted by the line', async () => {
    const d = await read();
    type Item = {
      name: string;
      quantity: number;
      optionGroups: Array<{ name: string; options: Array<{ name: string; quantity: number }> }>;
    };
    const wings = d.items.find((i: Item) => i.name === 'Boneless Wings') as Item;
    const byGroup = Object.fromEntries(wings.optionGroups.map((g) => [g.name, g.options]));

    // Two wings on one line with one sauce is two of that sauce — the whole
    // point of asking ("10 Buffalo Mild"), and the easy thing to get wrong.
    // The sauce and the dip stay apart, because they are two questions.
    expect(byGroup.Sauce).toEqual([{ name: 'Buffalo (Mild)', quantity: 2 }]);
    expect(byGroup.Dip).toEqual([{ name: 'Ranch', quantity: 2 }]);
    // The request the menu could not price is kept, under Other.
    expect(byGroup.Other).toEqual([{ name: 'Extra crispy', quantity: 2 }]);

    // An item nobody chose anything on says so, rather than inventing groups.
    const pizza = d.items.find((i: Item) => i.name === 'Large Cheese') as Item;
    expect(pizza.optionGroups).toEqual([]);
  });

  it('gives every top guest an id to link to their profile', async () => {
    const d = await read();
    expect(d.guests.top.length).toBeGreaterThan(0);
    for (const guest of d.guests.top) expect(guest.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cuts the series in the restaurant’s own days, gap-free', async () => {
    const d = await read();
    expect(d.series).toHaveLength(7);
    const friday = d.series.find((p: { start: string }) => p.start === '2026-09-11T00:00');
    // Both orders land on the same local Friday, though one of them is a
    // Saturday in UTC.
    expect(friday).toMatchObject({ calls: 3, orders: 2, revenueCents: 3700 });
    const quiet = d.series.find((p: { start: string }) => p.start === '2026-09-08T00:00');
    expect(quiet).toMatchObject({ calls: 0, orders: 0, revenueCents: 0 });
  });

  it('refuses a timezone it does not know and a backwards range', async () => {
    const badTz = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights?tz=Mars/Olympus`,
      headers: userHeaders,
    });
    expect(badTz.statusCode).toBe(400);
    expect(badTz.json().error.code).toBe('bad_timezone');

    const backwards = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights?from=${TO}&to=${FROM}&tz=${TZ}`,
      headers: userHeaders,
    });
    expect(backwards.statusCode).toBe(400);
    expect(backwards.json().error.code).toBe('bad_range');
  });

  it('will not read a location outside the caller’s tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/insights`,
      headers: { 'x-brayz-user-email': 'stranger@brayz.test', 'x-brayz-tenant-id': '00000000-0000-0000-0000-0000000000ff' },
    });
    expect([401, 403, 404]).toContain(res.statusCode);
  });
});
