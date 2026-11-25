import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Numbers no other test uses, and a location of its own: test files run in
// parallel against one database, and this one turns pickup off and changes
// the memory mode.
const TEST_NUMBER = '+15185550461';
const CALLER = '+15185554617';
const NOTIFY = '+15185554618';

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
const nodeGetHeaders = { 'x-brayz-node-secret': NODE_SECRET };
const userHeaders = { 'x-brayz-user-email': 'delivery-owner@brayz.test', 'x-brayz-tenant-id': TENANT };

// The restaurant, a street about a mile north of it, and Albany (about thirty miles).
const ORIGIN = { lat: 43.0831, lng: -73.7846 };
const NEAR = { lat: 43.0976, lng: -73.7846 };
const FAR = { lat: 42.6526, lng: -73.7562 };

const lookups: string[] = [];
const geocoder = {
  name: 'fake',
  async geocode(q: { street: string }) {
    lookups.push(q.street);
    if (/nowhere/i.test(q.street)) return null;
    if (/restaurant row/i.test(q.street)) return { ...ORIGIN, matchedAddress: q.street, postalCode: '12866' };
    if (/far/i.test(q.street)) return { ...FAR, matchedAddress: q.street, postalCode: '12207' };
    return { ...NEAR, matchedAddress: q.street, postalCode: '12866' };
  },
};

describe.skipIf(!dbUp)('Delivery orders (area, fee, minimum, saved address)', () => {
  let app: App;
  let locationId: string | undefined;
  let itemId: string;
  const texts: string[] = [];

  async function removeGuest(): Promise<void> {
    const gpn = await prisma.guestPhoneNumber.findUnique({
      where: { tenantId_e164: { tenantId: TENANT, e164: CALLER } },
      select: { guestId: true },
    });
    if (!gpn) return;
    await prisma.auditLog.deleteMany({ where: { targetId: gpn.guestId } }).catch(() => {});
    await prisma.guest.delete({ where: { id: gpn.guestId } }).catch(() => {});
  }

  async function guestRow() {
    const gpn = await prisma.guestPhoneNumber.findUnique({
      where: { tenantId_e164: { tenantId: TENANT, e164: CALLER } },
      select: { guestId: true },
    });
    return gpn ? prisma.guest.findUnique({ where: { id: gpn.guestId } }) : null;
  }

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: CALLER, toNumber: TEST_NUMBER },
    });
    return res.json().id;
  }

  const items = (quantity: number) => [{ menuItemId: itemId, name: 'Large Cheese', quantity }];

  function place(callId: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: { items: items(1), customerName: 'Dana', ...body },
    });
  }

  function tool(callId: string, path: string, payload?: unknown) {
    return payload === undefined
      ? app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/${path}`, headers: nodeGetHeaders })
      : app.inject({ method: 'POST', url: `/v1/calls/${callId}/tools/${path}`, headers: nodeHeaders, payload });
  }
  const check = async (callId: string, address: Record<string, unknown>) =>
    (await tool(callId, 'delivery/check', { address })).json();
  const confirm = async (callId: string, streetNumber: string) =>
    (await tool(callId, 'guest/address/confirm', { streetNumber })).json();
  const setMode = (mode: string) =>
    prisma.locationAiSettings.upsert({
      where: { locationId: locationId! },
      create: { locationId: locationId!, guestMemoryMode: mode },
      update: { guestMemoryMode: mode },
    });

  beforeAll(async () => {
    app = await buildApp({
      geocoder,
      notifier: {
        name: 'twilio',
        async sendSms(msg: { to: string; from?: string; body: string }) {
          texts.push(msg.body);
          return { providerMessageId: 'SM_fake' };
        },
      },
    });
    // Leftovers from an interrupted run.
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await removeGuest();

    const loc = await prisma.location.create({
      data: {
        tenantId: TENANT,
        name: 'Delivery Test Kitchen',
        addressLine1: '1 Restaurant Row',
        city: 'Saratoga Springs',
        region: 'NY',
        postalCode: '12866',
        notificationPhone: NOTIFY,
        deliveryEnabled: true,
        deliveryFeeCents: 299,
        deliveryMinimumCents: 1500,
        deliveryEtaMinutes: 50,
        deliveryZipCodes: ['12866'],
      },
    });
    locationId = loc.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, TENANT, locationId, NOTIFY);
    const menu = await prisma.menu.create({ data: { tenantId: TENANT, locationId, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' } });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large Cheese', priceCents: 1000, available: true },
    });
    itemId = item.id;
    await prisma.phoneNumber.create({ data: { tenantId: TENANT, locationId, e164Number: TEST_NUMBER } });
  });

  afterAll(async () => {
    if (locationId) await alertsCleanup(prisma, locationId);
    // Guarded: Prisma drops an undefined where-field, and an unguarded
    // deleteMany would empty the whole table.
    if (locationId) {
      await prisma.order.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.notification.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.phoneNumber.deleteMany({ where: { locationId } }).catch(() => {});
      await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    }
    await removeGuest();
    await app.close();
    await prisma.$disconnect();
  });

  it('checks an address against the ZIP list without a lookup, and asks for a missing ZIP', async () => {
    lookups.length = 0;
    const callId = await newCall();
    expect(await check(callId, { line1: '12 Main Street', postalCode: '12866-4410' })).toMatchObject({
      deliverable: true,
      check: 'in_zip',
      feeCents: 299,
      minimumCents: 1500,
      etaMinutes: 50,
    });
    expect(await check(callId, { line1: '9 Elm Street', postalCode: '12020' })).toMatchObject({
      deliverable: false,
      check: 'outside',
    });
    expect(await check(callId, { line1: '9 Elm Street' })).toMatchObject({ deliverable: false, check: 'needs_zip' });
    // No radius, so nothing needed looking up.
    expect(lookups).toEqual([]);
  });

  it('refuses a delivery with no address, under the minimum, outside the area, or missing its ZIP', async () => {
    const callId = await newCall();
    const refusal = async (body: Record<string, unknown>) => {
      const res = await place(callId, body);
      expect(res.statusCode).toBe(422);
      return res.json().error.code;
    };
    const home = { line1: '12 Main Street', postalCode: '12866' };
    expect(await refusal({ fulfillmentType: 'delivery', items: items(2) })).toBe('delivery_address_required');
    // $10.00 of food against a $15.00 minimum.
    expect(await refusal({ fulfillmentType: 'delivery', deliveryAddress: home })).toBe('below_delivery_minimum');
    expect(
      await refusal({
        fulfillmentType: 'delivery',
        items: items(2),
        deliveryAddress: { line1: '9 Elm Street', postalCode: '12020' },
      }),
    ).toBe('outside_delivery_area');
    expect(
      await refusal({ fulfillmentType: 'delivery', items: items(2), deliveryAddress: { line1: '9 Elm Street' } }),
    ).toBe('delivery_zip_required');
    expect(await prisma.order.count({ where: { callId } })).toBe(0);
  });

  it('places a delivery: fee on the total, address on the ticket and the text, and the guest keeps it', async () => {
    const callId = await newCall();
    const address = { line1: '12 Main Street', line2: 'Apt 2', postalCode: '12866', instructions: 'side door' };
    const res = await place(callId, { fulfillmentType: 'delivery', items: items(2), deliveryAddress: address });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ fulfillmentType: 'delivery', totalCents: 2299, deliveryFeeCents: 299, etaMinutes: 50 });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: body.id } });
    expect(order).toMatchObject({
      fulfillmentType: 'delivery',
      subtotalCents: 2000,
      totalCents: 2299,
      deliveryFeeCents: 299,
      deliveryAreaCheck: 'in_zip',
    });
    expect(order.deliveryAddress).toEqual(address);
    expect(texts.at(-1)).toMatch(
      new RegExp(
        `^New delivery order #${body.orderCode} for Dana: 2x Large Cheese\\. ` +
          'Deliver to 12 Main Street, Apt 2, 12866 \\(side door\\)\\. Total \\$22\\.99\\.',
      ),
    );

    const guest = await guestRow();
    expect(guest?.deliveryAddress).toEqual(address);
    expect(guest?.deliveryAddressUpdatedAt).toBeInstanceOf(Date);
  });

  it('a pickup order still works and quotes the pickup time; a location without pickup refuses one', async () => {
    const res = await place(await newCall(), {});
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fulfillmentType: 'pickup', totalCents: 1000, deliveryFeeCents: 0, etaMinutes: 20 });
    expect(texts.at(-1)).toMatch(/^New pickup order #/);

    await prisma.location.update({ where: { id: locationId }, data: { pickupEnabled: false } });
    try {
      const refused = await place(await newCall(), {});
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.code).toBe('pickup_unavailable');
    } finally {
      await prisma.location.update({ where: { id: locationId }, data: { pickupEnabled: true } });
    }
  });

  it('offers the saved address in full mode; confirm mode wants its street number first', async () => {
    const full = (await tool(await newCall(), 'guest')).json();
    expect(full).toMatchObject({
      isReturning: true,
      mode: 'full',
      hasSavedAddress: true,
      savedAddress: { line1: '12 Main Street', line2: 'Apt 2' },
    });

    await setMode('confirm');
    try {
      const callId = await newCall();
      const withheld = (await tool(callId, 'guest')).json();
      expect(withheld).toMatchObject({ isReturning: true, mode: 'confirm', hasSavedAddress: true, savedAddress: null });
      expect(JSON.stringify(withheld)).not.toContain('Main');

      const wrong = await confirm(callId, '14');
      expect(wrong).toEqual({ confirmed: false, reason: 'mismatch', attemptsLeft: 1 });
      // "Twelve" is not an answer yet — and not a wrong one either.
      expect(await confirm(callId, 'twelve')).toMatchObject({ confirmed: false, reason: 'unreadable', attemptsLeft: 1 });
      const right = await confirm(callId, '12');
      expect(right).toMatchObject({ confirmed: true, address: { line1: '12 Main Street', line2: 'Apt 2' } });
      const guest = await guestRow();
      expect(
        await prisma.auditLog.count({ where: { targetId: guest!.id, action: 'guest_profile.accessed' } }),
      ).toBeGreaterThan(0);

      // Two wrong numbers, and it is not offered again on that call.
      const locked = await newCall();
      await confirm(locked, '1');
      expect(await confirm(locked, '2')).toMatchObject({ reason: 'mismatch', attemptsLeft: 0 });
      expect(await confirm(locked, '12')).toEqual({ confirmed: false, reason: 'locked', attemptsLeft: 0 });
    } finally {
      await setMode('full');
    }
  });

  it('with memory off, nothing is offered and nothing is saved', async () => {
    await setMode('off');
    try {
      const callId = await newCall();
      expect((await tool(callId, 'guest')).json()).toMatchObject({ isReturning: false });
      expect((await tool(callId, 'guest/address/confirm', { streetNumber: '12' })).statusCode).toBe(403);
      const res = await place(callId, {
        fulfillmentType: 'delivery',
        items: items(2),
        deliveryAddress: { line1: '77 Oak Avenue', postalCode: '12866' },
      });
      expect(res.statusCode).toBe(201);
      expect((await guestRow())?.deliveryAddress).toMatchObject({ line1: '12 Main Street' });
    } finally {
      await setMode('full');
    }
  });

  it('by radius: near is in, far is out, and an address that cannot be placed is taken and flagged', async () => {
    await prisma.location.update({
      where: { id: locationId },
      data: { deliveryZipCodes: [], deliveryRadiusMiles: 5, latitude: null, longitude: null },
    });
    lookups.length = 0;
    const callId = await newCall();

    const near = await check(callId, { line1: '5 Near Street' });
    expect(near).toMatchObject({ deliverable: true, check: 'in_radius', postalCode: '12866' });
    expect(near.distanceMiles).toBeGreaterThan(0.5);
    expect(near.distanceMiles).toBeLessThan(1.5);
    // The restaurant was placed on the way — once — and kept.
    expect(lookups[0]).toBe('1 Restaurant Row');
    const kept = await prisma.location.findUniqueOrThrow({ where: { id: locationId }, select: { latitude: true } });
    expect(kept.latitude).toBeCloseTo(ORIGIN.lat);

    const far = await check(callId, { line1: '3 Far Road' });
    expect(far).toMatchObject({ deliverable: false, check: 'outside', radiusMiles: 5 });
    expect(far.distanceMiles).toBeGreaterThan(25);
    expect(lookups.filter((s) => s === '1 Restaurant Row')).toHaveLength(1);

    const lost = await place(callId, {
      fulfillmentType: 'delivery',
      items: items(2),
      deliveryAddress: { line1: '1 Nowhere Lane' },
    });
    expect(lost.statusCode).toBe(201);
    const flagged = await prisma.order.findUniqueOrThrow({ where: { id: lost.json().id } });
    expect(flagged.deliveryAreaCheck).toBe('unverified');
    expect(texts.at(-1)).toContain('Address not checked against the delivery area.');

    // The ZIP the lookup found goes on the ticket when the caller gave none.
    const nearby = await place(callId, {
      fulfillmentType: 'delivery',
      items: items(2),
      deliveryAddress: { line1: '5 Near Street' },
    });
    expect(nearby.statusCode).toBe(201);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: nearby.json().id } });
    expect(row.deliveryAddress).toEqual({ line1: '5 Near Street', postalCode: '12866' });
    expect(row.deliveryAreaCheck).toBe('in_radius');
  });

  it('settings normalize the ZIP list and place the restaurant; the owner can edit and remove a saved address', async () => {
    await prisma.location.update({ where: { id: locationId }, data: { latitude: null, longitude: null } });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${locationId}`,
      headers: userHeaders,
      payload: {
        deliveryZipCodes: [' 12866-1234', '12831', '12831'],
        deliveryRadiusMiles: 3,
        deliveryFeeCents: 350,
        pickupEtaMinutes: 25,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      deliveryZipCodes: ['12866', '12831'],
      deliveryRadiusMiles: 3,
      deliveryFeeCents: 350,
      pickupEtaMinutes: 25,
    });
    expect(res.json().latitude).toBeCloseTo(ORIGIN.lat);

    const tooFar = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${locationId}`,
      headers: userHeaders,
      payload: { deliveryRadiusMiles: 500 },
    });
    expect(tooFar.statusCode).toBe(400);

    const guest = await guestRow();
    const edited = await app.inject({
      method: 'PATCH',
      url: `/v1/guests/${guest!.id}`,
      headers: userHeaders,
      payload: { deliveryAddress: { line1: '40 Broadway', postalCode: '12866' } },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await guestRow())?.deliveryAddress).toEqual({ line1: '40 Broadway', postalCode: '12866' });

    const removed = await app.inject({
      method: 'PATCH',
      url: `/v1/guests/${guest!.id}`,
      headers: userHeaders,
      payload: { deliveryAddress: null },
    });
    expect(removed.statusCode).toBe(200);
    const after = await guestRow();
    expect(after?.deliveryAddress).toBeNull();
    expect(after?.deliveryAddressUpdatedAt).toBeNull();
  });
});
