import { createHmac } from 'node:crypto';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.TWILIO_AUTH_TOKEN = 'sms-delivery-test-token';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `sms-delivery-owner-${Date.now()}@brayz.test`;
const HOST = 'api.brayz.test';
const PATH = '/v1/carriers/twilio/sms-status';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { textLocation } = await import('../src/lib/notifier.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

/** A Twilio callback as Twilio would sign it. */
function sign(params: Record<string, string>, token = process.env.TWILIO_AUTH_TOKEN!): string {
  const data =
    `https://${HOST}${PATH}` +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k]}`)
      .join('');
  return createHmac('sha1', token).update(data).digest('base64');
}

/**
 * What became of a text. Every order and message text Brayz had sent was
 * undelivered (Twilio 30034, unregistered 10DLC) while the app said "sent",
 * because "sent" only meant Twilio accepted it. Texts now ask Twilio to report
 * delivery, the report is signed and recorded, and the dashboard can say the
 * restaurant is not getting its texts.
 */
describe.skipIf(!dbUp)('SMS delivery status', () => {
  let app: App;
  let locationId: string;
  let userId: string;

  beforeAll(async () => {
    app = await buildApp();
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'SMS Delivery Kitchen', notificationPhone: '+15185559876' },
    });
    locationId = location.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, SEEDED_TENANT, locationId, '+15185559876');
    const u = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = u.id;
    await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId, role: 'owner' } });
  });

  afterAll(async () => {
    if (locationId) await alertsCleanup(prisma, locationId);
    await prisma.notification.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const report = (params: Record<string, string>, signature = sign(params)) =>
    app.inject({
      method: 'POST',
      url: PATH,
      headers: {
        host: HOST,
        'x-forwarded-proto': 'https',
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      payload: new URLSearchParams(params).toString(),
    });

  const health = async () =>
    (
      await app.inject({
        method: 'GET',
        url: `/v1/locations/${locationId}/text-health`,
        headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT },
      })
    ).json();

  it('asks for a delivery report on the public URL and keeps the message id', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const notifier = {
      name: 'twilio',
      async sendSms(msg: Record<string, unknown>) {
        sent.push(msg);
        return { providerMessageId: 'SM-test-1' };
      },
    };
    const ok = await textLocation(app.log, notifier, {
      tenantId: SEEDED_TENANT,
      locationId,
      dedupeKey: `sms-delivery-test:${locationId}:1`,
      body: 'New pickup order #ABCDE',
      request: { headers: { host: HOST, 'x-forwarded-proto': 'https' }, protocol: 'http' },
    });
    expect(ok).toBe(true);
    expect(sent[0]).toMatchObject({ statusCallback: `https://${HOST}${PATH}` });
    const row = await prisma.notification.findUnique({ where: { providerMessageId: 'SM-test-1' } });
    expect(row).toMatchObject({ status: 'sent', deliveryStatus: null });
  });

  it('asks for no report from a local host a provider could never reach', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const notifier = {
      name: 'twilio',
      async sendSms(msg: Record<string, unknown>) {
        sent.push(msg);
        return { providerMessageId: 'SM-test-local' };
      },
    };
    await textLocation(app.log, notifier, {
      tenantId: SEEDED_TENANT,
      locationId,
      dedupeKey: `sms-delivery-test:${locationId}:local`,
      body: 'x',
      request: { headers: { host: 'localhost:4000' }, protocol: 'http' },
    });
    expect(sent[0]).not.toHaveProperty('statusCallback');
  });

  it('refuses a report without a valid signature', async () => {
    const params = { MessageSid: 'SM-test-1', MessageStatus: 'delivered' };
    expect((await report(params, 'bm90IGEgc2lnbmF0dXJl')).statusCode).toBe(403);
    expect((await report(params, sign(params, 'wrong-token'))).statusCode).toBe(403);
    const row = await prisma.notification.findUnique({ where: { providerMessageId: 'SM-test-1' } });
    expect(row?.deliveryStatus).toBeNull();
  });

  it('records delivery, and a late earlier status never overwrites it', async () => {
    expect((await report({ MessageSid: 'SM-test-1', MessageStatus: 'sent' })).statusCode).toBe(204);
    expect((await report({ MessageSid: 'SM-test-1', MessageStatus: 'delivered' })).statusCode).toBe(204);
    await report({ MessageSid: 'SM-test-1', MessageStatus: 'sent' });
    await report({ MessageSid: 'SM-test-1', MessageStatus: 'undelivered', ErrorCode: '30008' });
    const row = await prisma.notification.findUnique({ where: { providerMessageId: 'SM-test-1' } });
    expect(row).toMatchObject({ deliveryStatus: 'delivered', deliveryErrorCode: null });
    expect(row?.deliveryUpdatedAt).toBeTruthy();
    expect((await health()).latest).toMatchObject({ delivered: true, notDelivered: false, reason: null });
  });

  it('records an undelivered text with its reason, and the dashboard says so', async () => {
    await prisma.notification.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        channel: 'sms',
        status: 'sent',
        recipient: '+15185559876',
        body: 'New pickup order #FGHIJ',
        dedupeKey: `sms-delivery-test:${locationId}:2`,
        sentAt: new Date(),
        providerMessageId: 'SM-test-2',
      },
    });
    await report({ MessageSid: 'SM-test-2', MessageStatus: 'undelivered', ErrorCode: '30034' });
    const h = await health();
    expect(h.latest).toMatchObject({ notDelivered: true, errorCode: '30034' });
    expect(h.latest.reason).toMatch(/not registered for business texting/);
    expect(h).toMatchObject({ delivered: 1, notDelivered: 1 });
  });

  it('acknowledges a report for a text it never sent', async () => {
    expect((await report({ MessageSid: 'SM-unknown', MessageStatus: 'delivered' })).statusCode).toBe(204);
  });
});
