import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550124';

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

describe.skipIf(!dbUp)('Internal tool API (node-authed, callId-keyed)', () => {
  let app: App;
  let callId: string;
  const sentSms: Array<{ to: string; from?: string; body: string }> = [];

  beforeAll(async () => {
    app = await buildApp({
      notifier: {
        // Named for the carrier so the location's own number is the sender.
        name: 'twilio',
        async sendSms(msg: { to: string; from?: string; body: string }) {
          sentSms.push(msg);
          return { providerMessageId: 'SM_fake' };
        },
      },
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, e164Number: TEST_NUMBER },
    });
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts). The
    // seeded location is shared, but no other file texts from it.
    await alertsOn(prisma, SEEDED_TENANT, SEEDED_LOCATION, '+15185551298');
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551212', toNumber: TEST_NUMBER },
    });
    callId = create.json().id;
  });

  afterAll(async () => {
    // callId can be undefined if beforeAll failed; Prisma ignores undefined
    // where-fields, so an unguarded deleteMany would wipe the whole table.
    if (callId) await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    await prisma.callMessage.deleteMany({ where: { locationId: SEEDED_LOCATION } }).catch(() => {});
    await alertsCleanup(prisma, SEEDED_LOCATION);
    await prisma.location.update({ where: { id: SEEDED_LOCATION }, data: { notificationPhone: null } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { dedupeKey: { startsWith: 'message:' } } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects tool endpoints without the node secret', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/hours` });
    expect(res.statusCode).toBe(401);
  });

  it('returns the restaurant profile for the call location', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/profile`, headers: nodeHeaders });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: "Mario's Pizza — Albany",
      // One of the owner's greetings, chosen for this call, rides along so the
      // engine speaks it verbatim; so does a welcome-back line for a regular.
      greeting: expect.stringContaining("Mario's Pizza"),
      welcomeBack: expect.stringContaining('{guest_name}'),
      addressLine1: '123 Lark St',
      city: 'Albany',
      pickupEnabled: true,
      // How this location wants each item confirmed rides along with the
      // profile: the engine loads it once, before the first turn, and a
      // second request would be a round trip spent on a fixed setting.
      orderAckMode: 'fast',
    });
  });

  it('carries the location’s chosen confirmation style to the engine', async () => {
    await prisma.locationAiSettings.upsert({
      where: { locationId: SEEDED_LOCATION },
      update: { orderAckMode: 'natural' },
      create: { locationId: SEEDED_LOCATION, orderAckMode: 'natural' },
    });
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/profile`, headers: nodeHeaders });
    expect(res.json().orderAckMode).toBe('natural');
    await prisma.locationAiSettings.update({
      where: { locationId: SEEDED_LOCATION },
      data: { orderAckMode: 'fast' },
    });
  });

  it('returns weekly hours (seed: open 11:00–22:00 every day)', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/hours`, headers: nodeHeaders });
    expect(res.statusCode).toBe(200);
    const { hours } = res.json() as { hours: { dayOfWeek: number; opensAt: number; closesAt: number }[] };
    expect(hours).toHaveLength(7);
    expect(hours).toContainEqual({ dayOfWeek: 1, opensAt: 660, closesAt: 1320 });
  });

  it('searches the menu and returns prices in cents', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu?q=pizza`,
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json() as { items: { name: string; priceCents: number }[] };
    expect(items.some((i) => i.name === 'Large Cheese Pizza' && i.priceCents === 1499)).toBe(true);
    // The search is scoped: no non-pizza items leak in.
    expect(items.every((i) => /pizza/i.test(i.name))).toBe(true);
  });

  it('returns the full menu when no query is given', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/menu`, headers: nodeHeaders });
    const { items } = res.json() as { items: unknown[] };
    expect(items.length).toBeGreaterThanOrEqual(5);
  });

  it('takes a message: saves it, puts it on the call, and texts the restaurant', async () => {
    sentSms.length = 0;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/message`,
      headers: { ...nodeHeaders, 'content-type': 'application/json' },
      payload: { message: 'Wants to book the back room for twenty on Saturday', callerName: 'Dana' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; callbackNumber: string | null; notified: boolean };
    // No number given: the one the caller is on.
    expect(body.callbackNumber).toBe('+15185551212');
    expect(body.notified).toBe(true);

    const row = await prisma.callMessage.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({
      tenantId: SEEDED_TENANT,
      locationId: SEEDED_LOCATION,
      callId,
      callerName: 'Dana',
      callbackNumber: '+15185551212',
      status: 'new',
    });
    expect(row.notifiedAt).not.toBeNull();

    const events = await prisma.callEvent.findMany({ where: { callId, eventType: 'call.message' } });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { body?: string }).body).toContain('back room');

    expect(sentSms).toHaveLength(1);
    // The location's notification number, else its main phone. Not pinned:
    // other suites change the seeded location's numbers in parallel.
    expect(sentSms[0]!.to).toMatch(/^\+1518555\d{4}$/);
    // From one of the restaurant's lines rather than a global sender (there is
    // none in tests, so that would be undefined). Not pinned to a number: the
    // sender is the location's oldest line, usually another suite's, which that
    // suite can delete before this line runs. orders.integration pins it
    // exactly, on a location of its own.
    expect(sentSms[0]!.from).toMatch(/^\+1518555\d{4}$/);
    expect(sentSms[0]!.body).toContain('Message from Dana (+15185551212)');
    expect(sentSms[0]!.body).toContain('back room');
    const notif = await prisma.notification.findUnique({ where: { dedupeKey: `message:${body.id}` } });
    expect(notif?.status).toBe('sent');
  });

  it('keeps a callback number the caller gave instead of the one they called from', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/message`,
      headers: { ...nodeHeaders, 'content-type': 'application/json' },
      payload: { message: 'Call my office', callbackNumber: '+15185550100' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().callbackNumber).toBe('+15185550100');
    const row = await prisma.callMessage.findUniqueOrThrow({ where: { id: res.json().id } });
    expect(row.callerName).toBeNull();
  });

  it('404s for an unknown call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/calls/99999999-9999-9999-9999-999999999999/tools/hours',
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * The live failure: Saratoga has 111 available items, the search took the first
 * 25 ordered by name, and "Sgt Peppers" sits past the letter B. Asking for it
 * matched, then lost its place to every earlier-alphabet pizza, and the bot told
 * the caller the item was not on the menu.
 */
describe.skipIf(!dbUp)('Menu search ranking', () => {
  const RANK_NUMBER = '+15185550137'; // this file owns 0124 and 0137 (see #14: one file, one set)
  let app: App;
  let tenantId: string | undefined;
  let locationId: string | undefined;
  let callId: string | undefined;

  beforeAll(async () => {
    app = await buildApp();
    // Its own tenant, not the seeded one: an extra location under a shared
    // tenant is visible to every other suite while this one runs, which is the
    // fixture bleed #14 went to the trouble of removing.
    const tenant = await prisma.tenant.create({ data: { name: 'Ranking Test Tenant' } });
    tenantId = tenant.id;
    const location = await prisma.location.create({
      data: { tenantId, name: 'Ranking Test Location', timezone: 'America/New_York' },
    });
    locationId = location.id;
    const menu = await prisma.menu.create({ data: { tenantId, locationId, active: true } });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizzas', sortOrder: 0 },
    });
    // The other half of the live "sausage pizza" failure: a sub whose name is a
    // pizza topping. Only the section it sits in tells the two apart.
    const subs = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Hot Subs', sortOrder: 1 },
    });
    await prisma.menuItem.create({
      data: { categoryId: subs.id, name: 'Sausage', priceCents: 1200, available: true },
    });

    // Enough earlier-alphabet pizzas to push the real answer past any fixed take.
    await prisma.menuItem.createMany({
      data: [
        ...Array.from({ length: 30 }, (_, i) => ({
          categoryId: category.id,
          name: `BBQ Chicken Pizza ${String(i).padStart(2, '0')}`,
          priceCents: 1500,
          available: true,
        })),
        {
          categoryId: category.id,
          name: 'Sgt Peppers (Large)',
          description: 'Red sauce, sausage, roasted red peppers',
          priceCents: 2100,
          available: true,
        },
      ],
    });

    await prisma.phoneNumber.deleteMany({ where: { e164Number: RANK_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId, locationId, e164Number: RANK_NUMBER },
    });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551214', toNumber: RANK_NUMBER },
    });
    callId = create.json().id;
  });

  afterAll(async () => {
    if (callId) await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: RANK_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (tenantId) await prisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    await app.close();
  });

  it('ranks the item the caller named above every other pizza', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu?q=${encodeURIComponent('Sargent Pepper pizza')}`,
      headers: nodeHeaders,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ name: string }>;
    // "pizza" matches all 30 decoys and "pepper" only this one, so the rare word
    // has to win — first place, not merely present.
    expect(items[0].name).toBe('Sgt Peppers (Large)');
  });

  it('returns the whole menu when no query is given, not a first-page slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu`,
      headers: nodeHeaders,
    });
    const items = res.json().items as Array<{ name: string }>;
    // The engine loads this to resolve spoken names into real items; a cap here
    // means it cannot order anything late in the alphabet.
    expect(items).toHaveLength(32);
    expect(items.map((i) => i.name)).toContain('Sgt Peppers (Large)');
  });

  it('falls back to the full menu when nothing matches at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu?q=sushi`,
      headers: nodeHeaders,
    });
    expect(res.json().items).toHaveLength(32);
  });

  it('says which section every item belongs to', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu?q=${encodeURIComponent('sausage pizza')}`,
      headers: nodeHeaders,
    });
    const items = res.json().items as Array<{ name: string; category: string }>;
    // Without the section, "Sausage" and a pizza are the same kind of line to
    // the bot, and it took the sub when the caller asked for a sausage pizza.
    expect(items.find((i) => i.name === 'Sausage')?.category).toBe('Hot Subs');
    expect(items.find((i) => i.name === 'Sgt Peppers (Large)')?.category).toBe('Pizzas');
    expect(items.every((i) => typeof i.category === 'string' && i.category.length > 0)).toBe(true);
  });

  it('returns the menu in section order, not one flat alphabetical list', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/menu`,
      headers: nodeHeaders,
    });
    const items = res.json().items as Array<{ category: string }>;
    // The engine groups by section as it walks this list, so a section that
    // comes back in two pieces would print twice in the prompt.
    const sections = items.map((i) => i.category).filter((c, i, a) => c !== a[i - 1]);
    expect(sections).toEqual(['Pizzas', 'Hot Subs']);
  });
});
