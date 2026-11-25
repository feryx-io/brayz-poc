import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550177';
const TZ = 'America/New_York';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { localParts } = await import('../src/lib/hours.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET };

/**
 * The hours are built around the moment the test runs, so the answers do not
 * depend on the clock: a weekday three days from today is one the restaurant is
 * certainly shut on now, and an all-day row for today is one it is certainly
 * open on.
 */
const today = localParts(new Date(), TZ);
const OPEN_DAY = (today.dayOfWeek + 3) % 7;

describe.skipIf(!dbUp)('Closed hours and ordering ahead', () => {
  let app: App;
  let locationId: string;
  let callId: string;
  let menuItemId: string;
  const sentSms: Array<{ to: string; body: string }> = [];

  /** The next calendar date, local, that falls on the one open weekday. */
  const nextOpenDate = (): string => {
    const [y, m, d] = today.date.split('-').map(Number);
    for (let i = 1; i <= 7; i += 1) {
      const at = new Date(Date.UTC(y!, m! - 1, d! + i));
      if (at.getUTCDay() === OPEN_DAY) return at.toISOString().slice(0, 10);
    }
    throw new Error('unreachable');
  };

  const setSettings = (patch: Record<string, unknown>) =>
    prisma.locationAiSettings.upsert({
      where: { locationId },
      update: patch,
      create: { locationId, ...patch },
    });

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
        name: 'Closed Hours Test Kitchen',
        timezone: TZ,
        mainPhone: '+15185550100',
        pickupEnabled: true,
        pickupEtaMinutes: 20,
      },
    });
    locationId = location.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, TENANT, locationId, '+15185550100');
    // Open 11:00–22:00, but only on a day that is not today — so the
    // restaurant is shut for the whole of this test run.
    await prisma.locationHours.create({
      data: { locationId, dayOfWeek: OPEN_DAY, opensAt: 11 * 60, closesAt: 22 * 60 },
    });
    await setSettings({ closedBehavior: 'announce', scheduleOrdersEnabled: true, scheduleMaxDaysAhead: 7 });

    const menu = await prisma.menu.create({ data: { tenantId: TENANT, locationId, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' } });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large Cheese', priceCents: 1900, available: true },
    });
    menuItemId = item.id;

    await prisma.phoneNumber.create({ data: { tenantId: TENANT, locationId, e164Number: TEST_NUMBER } });
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551313', toNumber: TEST_NUMBER },
    });
    callId = create.json().id;
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

  const profile = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/profile`,
      headers: nodeHeaders,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  const schedule = async (body: { time: string; day?: string }) => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/schedule`,
      headers: nodeHeaders,
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  const placeOrder = (body: Record<string, unknown> = {}) =>
    app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [{ menuItemId, name: 'Large Cheese', quantity: 1 }],
        customerName: 'James',
        fulfillmentType: 'pickup',
        ...body,
      },
    });

  it('tells the bot the restaurant is shut, and when it opens next', async () => {
    const p = await profile();
    expect(p.openNow).toBe(false);
    expect(p.hoursKnown).toBe(true);
    expect(p.announceClosed).toBe(true);
    // Phrased by the API, which is the only side that knows the timezone.
    expect(p.nextOpen?.spoken).toMatch(/at \d{1,2}:\d{2} (AM|PM)$/);
    expect(p.scheduling).toMatchObject({ enabled: true, maxDaysAhead: 7, leadMinutes: 20 });
    // Today's date, said — so a date the caller names is not the model's guess.
    expect(p.scheduling.today).toMatch(/^[A-Z][a-z]+day, [A-Z][a-z]+ \d{1,2}$/);
  });

  it('takes the day as a weekday name, the way the caller said it', async () => {
    const weekday = new Date(`${nextOpenDate()}T12:00:00Z`)
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' })
      .toLowerCase();
    const answer = await schedule({ time: '12:00', day: weekday });
    expect(answer.ok).toBe(true);
    expect(answer.scheduledFor.slice(0, 10)).toBe(nextOpenDate());
  });

  it('agrees a time the restaurant is open for, and says it back', async () => {
    const answer = await schedule({ time: '12:00', day: nextOpenDate() });
    expect(answer.ok).toBe(true);
    expect(answer.spoken).toMatch(/12:00 PM$/);
    expect(new Date(answer.scheduledFor).getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a time it is shut at, and offers the earliest that works', async () => {
    const answer = await schedule({ time: '09:00', day: nextOpenDate() });
    expect(answer).toMatchObject({ ok: false, reason: 'closed_then' });
    // Never a dead end: the refusal carries a time the bot can offer instead.
    expect(answer.earliest?.spoken).toMatch(/11:20 AM$/);
  });

  it('refuses a time that has already gone by', async () => {
    const answer = await schedule({ time: '00:01' });
    expect(answer.ok).toBe(false);
    expect(['past', 'closed_then']).toContain(answer.reason);
  });

  it('refuses to take an order at all while the restaurant is closed', async () => {
    const res = await placeOrder();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'closed' } });
  });

  it('takes the order for a time it agreed to, and puts it on the ticket', async () => {
    const when = await schedule({ time: '12:00', day: nextOpenDate() });
    const res = await placeOrder({ scheduledFor: when.scheduledFor });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    expect(body.scheduledFor).toBe(when.scheduledFor);
    expect(body.scheduledSpoken).toMatch(/12:00 PM$/);
    const order = await prisma.order.findUnique({ where: { id: body.id }, select: { scheduledFor: true } });
    expect(order?.scheduledFor?.toISOString()).toBe(when.scheduledFor);
    // The kitchen's copy leads with the time — a call-ahead read as a live
    // ticket is a pizza made hours too early.
    expect(sentSms.at(-1)?.body.startsWith('FOR ')).toBe(true);
  });

  it('refuses a time the caller could not have been offered', async () => {
    const res = await placeOrder({ scheduledFor: new Date(Date.now() - 60_000).toISOString() });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'schedule_unavailable' } });
  });

  it('leaves a location that never asked for the announcement exactly as it was', async () => {
    await setSettings({ closedBehavior: 'take_orders' });
    const p = await profile();
    expect(p.openNow).toBe(false);
    expect(p.announceClosed).toBe(false);
    const res = await placeOrder();
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().scheduledFor).toBeNull();
    await setSettings({ closedBehavior: 'announce' });
  });

  it('does not schedule for a location that has not turned ordering ahead on', async () => {
    await setSettings({ scheduleOrdersEnabled: false });
    const answer = await schedule({ time: '12:00', day: nextOpenDate() });
    expect(answer).toMatchObject({ ok: false, reason: 'disabled' });
    const p = await profile();
    expect(p.scheduling.enabled).toBe(false);
    await setSettings({ scheduleOrdersEnabled: true });
  });
});
