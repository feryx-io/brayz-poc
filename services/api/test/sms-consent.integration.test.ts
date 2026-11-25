import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.TWILIO_AUTH_TOKEN = 'sms-consent-test-token';

const TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `sms-consent-owner-${Date.now()}@brayz.test`;
const STAFF_EMAIL = `sms-consent-staff-${Date.now()}@brayz.test`;
// Unique to this file: the restaurant's line, which replies come in to.
const LINE_NUMBER = '+15185550188';
const OTHER_LINE_NUMBER = '+15185550189';
const OWNER_CELL = '+15185557701';
const HOST = 'api.brayz.test';
const INBOUND = '/v1/carriers/twilio/sms-inbound';

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

function sign(params: Record<string, string>): string {
  const data = `https://${HOST}${INBOUND}` + Object.keys(params).sort().map((k) => `${k}${params[k]}`).join('');
  return createHmac('sha1', process.env.TWILIO_AUTH_TOKEN!).update(data).digest('base64');
}

/**
 * A restaurant agreeing to its alert texts (rule #6). The owner checks an
 * unchecked box beside the disclosure; that is recorded with who, when and the
 * words, and a confirmation text goes out. Alerts go only after the number
 * replies YES. STOP ends them; so does turning them off in the dashboard, which
 * a text reply cannot undo.
 */
describe.skipIf(!dbUp)('SMS consent for restaurant alerts', () => {
  let app: App;
  let locationId: string;
  let otherTenantId: string;
  let otherLocationId: string;
  const userIds: string[] = [];
  const sent: Array<{ to: string; body: string }> = [];

  beforeAll(async () => {
    app = await buildApp({
      notifier: {
        name: 'twilio',
        async sendSms(msg: { to: string; body: string }) {
          sent.push(msg);
          return { providerMessageId: `SM-consent-${sent.length}-${Date.now()}` };
        },
      },
    });
    const location = await prisma.location.create({ data: { tenantId: TENANT, name: 'Consent Kitchen' } });
    locationId = location.id;
    await prisma.phoneNumber.deleteMany({ where: { e164Number: { in: [LINE_NUMBER, OTHER_LINE_NUMBER] } } });
    await prisma.phoneNumber.create({ data: { tenantId: TENANT, locationId, e164Number: LINE_NUMBER } });
    // Another restaurant, whose customer happens to use the same cell.
    const other = await prisma.tenant.create({ data: { name: 'Consent Elsewhere' } });
    otherTenantId = other.id;
    const otherLoc = await prisma.location.create({ data: { tenantId: otherTenantId, name: 'Elsewhere' } });
    otherLocationId = otherLoc.id;
    await prisma.phoneNumber.create({ data: { tenantId: otherTenantId, locationId: otherLocationId, e164Number: OTHER_LINE_NUMBER } });
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [STAFF_EMAIL, 'staff'],
    ] as const) {
      const u = await prisma.user.create({ data: { email, authSubject: email } });
      userIds.push(u.id);
      await prisma.userTenantMembership.create({ data: { tenantId: TENANT, userId: u.id, role } });
    }
  });

  afterAll(async () => {
    const locs = [locationId, otherLocationId].filter(Boolean);
    await prisma.smsConsentRecord.deleteMany({ where: { locationId: { in: locs } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { locationId: { in: locs } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { locationId: { in: locs } } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: { in: [LINE_NUMBER, OTHER_LINE_NUMBER] } } }).catch(() => {});
    await prisma.location.deleteMany({ where: { id: { in: locs } } }).catch(() => {});
    if (otherTenantId) await prisma.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
    await prisma.userTenantMembership.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const as = (email: string) => ({ 'x-brayz-user-email': email, 'x-brayz-tenant-id': TENANT });
  const consent = async () =>
    (await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/sms-consent`, headers: as(OWNER_EMAIL) })).json();
  const reply = (body: string, to = LINE_NUMBER, from = OWNER_CELL, extra: Record<string, string> = {}) => {
    const params = { MessageSid: `SM-in-${Date.now()}-${Math.random()}`, From: from, To: to, Body: body, ...extra };
    return app.inject({
      method: 'POST',
      url: INBOUND,
      headers: { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(params) },
      payload: new URLSearchParams(params).toString(),
    });
  };
  const alert = (n: string) =>
    textLocation(app.log, { name: 'twilio', sendSms: async (m) => (sent.push(m), { providerMessageId: `SM-alert-${n}` }) }, {
      tenantId: TENANT,
      locationId,
      dedupeKey: `sms-consent-test:${locationId}:${n}`,
      body: `New pickup order #${n}`,
    });

  it('starts with no consent, and shows the words to agree to', async () => {
    const c = await consent();
    expect(c).toMatchObject({ state: 'none', phone: null, disclosureVersion: 'restaurant-alerts-v1' });
    expect(c.disclosure).toContain('Consent Kitchen');
    expect(c.disclosure).toContain('Reply STOP to opt out');
  });

  it('refuses without the box checked, and refuses staff', async () => {
    const url = `/v1/locations/${locationId}/sms-consent`;
    expect((await app.inject({ method: 'POST', url, headers: as(OWNER_EMAIL), payload: { phone: OWNER_CELL } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: as(OWNER_EMAIL), payload: { phone: OWNER_CELL, agreed: false } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: as(STAFF_EMAIL), payload: { phone: OWNER_CELL, agreed: true } })).statusCode).toBe(403);
  });

  it('records the grant with who and where, and texts the number to confirm', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/sms-consent`,
      headers: { ...as(OWNER_EMAIL), 'user-agent': 'consent-test-browser' },
      payload: { phone: OWNER_CELL, agreed: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ state: 'pending', confirmationSent: true });
    expect(sent.at(-1)).toMatchObject({ to: OWNER_CELL });
    expect(sent.at(-1)!.body).toContain('Reply YES');
    const grant = await prisma.smsConsentRecord.findFirst({ where: { locationId }, orderBy: { createdAt: 'desc' } });
    expect(grant).toMatchObject({ action: 'granted', source: 'dashboard', phone: OWNER_CELL, userAgent: 'consent-test-browser' });
    expect(grant?.actorUserId).toBe(userIds[0]);
    expect(grant?.disclosureText).toContain('Consent Kitchen');
    expect(await prisma.auditLog.count({ where: { locationId, action: 'consent.changed' } })).toBe(1);
    expect((await consent()).state).toBe('pending');
  });

  it('sends no alert while waiting on YES', async () => {
    const before = sent.length;
    expect(await alert('WAIT1')).toBe(false);
    expect(sent.length).toBe(before);
    const row = await prisma.notification.findUnique({ where: { dedupeKey: `sms-consent-test:${locationId}:WAIT1` } });
    expect(row?.status).toBe('skipped_no_consent');
  });

  it('refuses an unsigned reply', async () => {
    const res = await app.inject({
      method: 'POST',
      url: INBOUND,
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' },
      payload: new URLSearchParams({ MessageSid: 'SM-x', From: OWNER_CELL, To: LINE_NUMBER, Body: 'YES' }).toString(),
    });
    expect(res.statusCode).toBe(403);
    expect((await consent()).state).toBe('pending');
  });

  it('a YES to another restaurant’s number changes nothing here', async () => {
    expect((await reply('YES', OTHER_LINE_NUMBER)).statusCode).toBe(200);
    expect((await consent()).state).toBe('pending');
  });

  it('turns alerts on at YES, and alerts go', async () => {
    const res = await reply('Yes!');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<Response></Response>');
    expect((await consent()).state).toBe('on');
    const before = sent.length;
    expect(await alert('ON1')).toBe(true);
    expect(sent.length).toBe(before + 1);
    // A repeated YES (a retried webhook) adds nothing.
    await reply('YES');
    expect(await prisma.smsConsentRecord.count({ where: { locationId, action: 'confirmed' } })).toBe(1);
  });

  it('STOP ends them, and START by text brings them back', async () => {
    await reply('STOP');
    expect((await consent()).state).toBe('off');
    expect(await alert('OFF1')).toBe(false);
    await reply('start', LINE_NUMBER, OWNER_CELL, { OptOutType: 'START' });
    expect((await consent()).state).toBe('on');
  });

  it('turned off in the dashboard, a text reply cannot turn them back on', async () => {
    const res = await app.inject({ method: 'DELETE', url: `/v1/locations/${locationId}/sms-consent`, headers: as(OWNER_EMAIL) });
    expect(res.json()).toEqual({ state: 'off' });
    await reply('YES');
    expect((await consent()).state).toBe('off');
    const actions = (await prisma.smsConsentRecord.findMany({ where: { locationId }, orderBy: { createdAt: 'asc' } })).map(
      (r) => `${r.action}:${r.source}`,
    );
    expect(actions).toEqual([
      'granted:dashboard',
      'confirmed:sms_reply',
      'revoked:sms_reply',
      'confirmed:sms_reply',
      'revoked:dashboard',
    ]);
  });
});
