import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.TWILIO_AUTH_TOKEN = 'guest-texts-test-token';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `guest-texts-owner-${Date.now()}@brayz.test`;
const NODE_SECRET = 'dev-only-change-me';
// Unique to this file.
const TEST_NUMBER = '+15185550191';
const CALLER = '+15185551390';
const HOST = 'api.brayz.test';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { orderCode } = await import('../src/lib/orderMapping.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const node = { 'x-brayz-node-secret': NODE_SECRET, 'content-type': 'application/json' };

/**
 * A caller agreeing, on the call, to a text when their order is ready (rule
 * #6). The bot asks in fixed words; the API records the yes with those words,
 * the call and the caller's reply, texts a confirmation, and texts again when
 * the kitchen marks the order ready — and never without that yes.
 */
describe.skipIf(!dbUp)('Guest order-update texts', () => {
  let app: App;
  let locationId: string;
  let userId: string;
  const callIds: string[] = [];
  const sent: Array<{ to: string; body: string }> = [];

  beforeAll(async () => {
    app = await buildApp({
      notifier: {
        name: 'twilio',
        async sendSms(msg: { to: string; body: string }) {
          sent.push(msg);
          return { providerMessageId: `SM-guest-${sent.length}-${Date.now()}` };
        },
      },
    });
    const location = await prisma.location.create({
      data: { tenantId: TENANT, name: 'Guest Texts Kitchen', pickupEnabled: true },
    });
    locationId = location.id;
    await prisma.locationAiSettings.create({ data: { locationId, guestOrderTextsEnabled: true } });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({ data: { tenantId: TENANT, locationId, e164Number: TEST_NUMBER } });
    const u = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = u.id;
    await prisma.userTenantMembership.create({ data: { tenantId: TENANT, userId, role: 'owner' } });
  });

  afterAll(async () => {
    await prisma.smsConsentRecord.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.order.deleteMany({ where: { locationId } }).catch(() => {});
    if (callIds.length) await prisma.call.deleteMany({ where: { id: { in: callIds } } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  async function callWithOrder(fromNumber: string | null) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: node,
      payload: { provider: 'twilio', toNumber: TEST_NUMBER, ...(fromNumber ? { fromNumber } : {}) },
    });
    const callId = res.json().id as string;
    callIds.push(callId);
    const order = await prisma.order.create({
      data: {
        tenantId: TENANT,
        locationId,
        callId,
        status: 'confirmed',
        customerName: 'Sam',
        customerPhone: fromNumber,
        subtotalCents: 1900,
        totalCents: 1900,
      },
      select: { id: true },
    });
    return { callId, orderId: order.id, code: orderCode(order.id) };
  }

  const profile = async (callId: string) =>
    (await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/profile`, headers: node })).json();
  const agree = (callId: string, code: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/order-texts/consent`,
      headers: node,
      payload: { orderCode: code, callerWords: 'Yeah, sure.' },
    });
  const setStatus = (orderId: string, status: string) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/orders/${orderId}`,
      headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': TENANT },
      payload: { status },
    });

  it('offers the text on a call with a caller ID, and not without one', async () => {
    const withId = await callWithOrder(CALLER);
    expect((await profile(withId.callId)).guestOrderTexts).toEqual({ offer: true });
    const withoutId = await callWithOrder(null);
    expect((await profile(withoutId.callId)).guestOrderTexts).toEqual({ offer: false });
  });

  it('does not text a guest who never said yes when their order is ready', async () => {
    const { orderId } = await callWithOrder(CALLER);
    const before = sent.length;
    expect((await setStatus(orderId, 'ready')).statusCode).toBe(200);
    expect(sent.length).toBe(before);
    const row = await prisma.notification.findUnique({ where: { dedupeKey: `guest-order-ready:${orderId}` } });
    expect(row).toMatchObject({ status: 'skipped_no_consent', audience: 'guest' });
  });

  it('refuses a yes for an order that is not this call’s', async () => {
    const { callId } = await callWithOrder(CALLER);
    expect((await agree(callId, 'ZZZZZ')).statusCode).toBe(404);
  });

  it('records the spoken yes with the words, the call and the reply, and texts a confirmation', async () => {
    const { callId, orderId, code } = await callWithOrder(CALLER);
    const res = await agree(callId, code);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ consented: true, confirmationSent: true });
    const record = await prisma.smsConsentRecord.findFirst({
      where: { locationId, phone: CALLER, purpose: 'guest_order_updates' },
      orderBy: { createdAt: 'desc' },
    });
    expect(record).toMatchObject({
      action: 'confirmed',
      source: 'voice_call',
      callId,
      replyText: 'Yeah, sure.',
      disclosureVersion: 'guest-order-updates-v2',
      orderId,
    });
    expect(record?.disclosureText).toContain('Guest Texts Kitchen will text the number you');
    expect(record?.disclosureText).toContain('reply STOP');
    expect(sent.at(-1)).toMatchObject({ to: CALLER });
    expect(sent.at(-1)!.body).toContain(`order #${code} is ready`);
    expect(await prisma.auditLog.count({ where: { locationId, action: 'consent.changed' } })).toBeGreaterThan(0);

    // The kitchen marks it ready: one text, however many times it is marked.
    const before = sent.length;
    expect((await setStatus(orderId, 'ready')).statusCode).toBe(200);
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)).toMatchObject({ to: CALLER, body: expect.stringContaining(`order #${code} is ready for pickup`) });
    // And none of it counts as the restaurant's own texts failing or not.
    const health = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/text-health`,
      headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': TENANT },
    });
    expect(health.json().sent).toBe(0);
  });

  it('a yes covers the order it was given for, not the next one', async () => {
    const first = await callWithOrder(CALLER);
    expect((await agree(first.callId, first.code)).statusCode).toBe(201);
    // They call again and order: the offer said "about this order", so they are
    // asked again, and without a new yes the new order is not texted.
    const next = await callWithOrder(CALLER);
    expect((await profile(next.callId)).guestOrderTexts).toEqual({ offer: true });
    const before = sent.length;
    expect((await setStatus(next.orderId, 'ready')).statusCode).toBe(200);
    expect(sent.length).toBe(before);
    const row = await prisma.notification.findUnique({ where: { dedupeKey: `guest-order-ready:${next.orderId}` } });
    expect(row).toMatchObject({ status: 'skipped_no_consent', audience: 'guest' });
  });

  it('STOP by text ends a guest’s order texts', async () => {
    const { callId, orderId, code } = await callWithOrder(CALLER);
    expect((await agree(callId, code)).statusCode).toBe(201);
    const params = { MessageSid: `SM-stop-${Date.now()}`, From: CALLER, To: TEST_NUMBER, Body: 'STOP' };
    const data = `https://${HOST}/v1/carriers/twilio/sms-inbound` + Object.keys(params).sort().map((k) => `${k}${params[k as keyof typeof params]}`).join('');
    const signature = createHmac('sha1', process.env.TWILIO_AUTH_TOKEN!).update(data).digest('base64');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/carriers/twilio/sms-inbound',
      headers: { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(params).toString(),
    });
    expect(res.statusCode).toBe(200);
    const before = sent.length;
    await setStatus(orderId, 'ready');
    expect(sent.length).toBe(before);
    const latest = await prisma.smsConsentRecord.findFirst({
      where: { locationId, phone: CALLER, purpose: 'guest_order_updates' },
      orderBy: { createdAt: 'desc' },
    });
    expect(latest).toMatchObject({ action: 'revoked', source: 'sms_reply' });
  });

  it('refuses a yes when the restaurant has guest texts off', async () => {
    await prisma.locationAiSettings.update({ where: { locationId }, data: { guestOrderTextsEnabled: false } });
    const { callId, code } = await callWithOrder(CALLER);
    expect((await agree(callId, code)).statusCode).toBe(409);
    expect((await profile(callId)).guestOrderTexts.offer).toBe(false);
  });
});
