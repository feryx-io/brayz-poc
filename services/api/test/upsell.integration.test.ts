import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3RecordingStorage } from '../src/lib/recordingStorage.js';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file — upsell owns 0134, and its own location + menu.
const TEST_NUMBER = '+15185550134';
const OWNER_EMAIL = `upsell-owner-${Date.now()}@brayz.test`;

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
};

describe.skipIf(!dbUp)('Upsell suggestions and attribution', () => {
  let app: App;
  let locationId: string;
  let pizzaId: string;
  let knotsId: string;
  let sodaId: string;
  let saladId: string;
  let userId: string | undefined;
  const callIds: string[] = [];

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551334', toNumber: TEST_NUMBER },
    });
    const id = res.json().id as string;
    callIds.push(id);
    return id;
  }

  async function suggestFor(callId: string, lines: Array<{ menuItemId?: string; name: string }>) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/upsell`,
      headers: nodeHeaders,
      payload: { lines },
    });
    expect(res.statusCode).toBe(200);
    return res.json().suggestions as Array<{
      menuItemId: string;
      name: string;
      priceCents: number;
    }>;
  }

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Upsell Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Upsell Menu', active: true },
      select: { id: true },
    });
    const pizzaCat = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza' },
      select: { id: true },
    });
    const sidesCat = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Sides' },
      select: { id: true },
    });

    pizzaId = (
      await prisma.menuItem.create({
        data: { categoryId: pizzaCat.id, name: 'Large cheese pizza', priceCents: 1800 },
        select: { id: true },
      })
    ).id;
    // Tagged to pair with the Pizza category. Cheapest, so it should lead.
    sodaId = (
      await prisma.menuItem.create({
        data: {
          categoryId: sidesCat.id,
          name: 'Soda',
          priceCents: 250,
          upsellTags: ['pizza'],
        },
        select: { id: true },
      })
    ).id;
    knotsId = (
      await prisma.menuItem.create({
        data: {
          categoryId: sidesCat.id,
          name: 'Garlic knots',
          priceCents: 599,
          upsellTags: ['pizza'],
        },
        select: { id: true },
      })
    ).id;
    // Untagged: never suggested, however tempting.
    saladId = (
      await prisma.menuItem.create({
        data: { categoryId: sidesCat.id, name: 'Side salad', priceCents: 450 },
        select: { id: true },
      })
    ).id;

    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    for (const id of callIds) {
      await prisma.order.deleteMany({ where: { callId: id } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.guest.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('suggests tagged add-ons for what is in the order, cheapest first', async () => {
    const callId = await newCall();
    const suggestions = await suggestFor(callId, [
      { menuItemId: pizzaId, name: 'Large cheese pizza' },
    ]);
    // Cheapest first — the add-on a caller says yes to on the phone.
    expect(suggestions.map((s) => s.name)).toEqual(['Soda', 'Garlic knots']);
    // Priced from the live menu, so the bot never has to work one out.
    expect(suggestions[0].priceCents).toBe(250);
    // Untagged items are never offered.
    expect(suggestions.map((s) => s.menuItemId)).not.toContain(saladId);
  });

  it('matches a tag against the item’s category as well as its name', async () => {
    const callId = await newCall();
    // The line names a pizza that isn't the tagged word itself; "pizza" matches
    // through the category the item sits in.
    const suggestions = await suggestFor(callId, [
      { menuItemId: pizzaId, name: 'Large cheese pizza' },
    ]);
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it('never suggests something already in the order', async () => {
    const callId = await newCall();
    const suggestions = await suggestFor(callId, [
      { menuItemId: pizzaId, name: 'Large cheese pizza' },
      { menuItemId: sodaId, name: 'Soda' },
    ]);
    expect(suggestions.map((s) => s.menuItemId)).not.toContain(sodaId);
    expect(suggestions.map((s) => s.name)).toEqual(['Garlic knots']);
  });

  it('suggests nothing for an empty order, or one with no pairing', async () => {
    const callId = await newCall();
    expect(await suggestFor(callId, [])).toEqual([]);
    expect(await suggestFor(callId, [{ menuItemId: saladId, name: 'Side salad' }])).toEqual([]);
  });

  it('skips an add-on that has been marked unavailable', async () => {
    await prisma.menuItem.update({ where: { id: sodaId }, data: { available: false } });
    const callId = await newCall();
    const suggestions = await suggestFor(callId, [
      { menuItemId: pizzaId, name: 'Large cheese pizza' },
    ]);
    expect(suggestions.map((s) => s.name)).toEqual(['Garlic knots']);
    await prisma.menuItem.update({ where: { id: sodaId }, data: { available: true } });
  });

  it('records which lines came from an upsell, without letting it touch the price', async () => {
    const callId = await newCall();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: {
        items: [
          { menuItemId: pizzaId, name: 'Large cheese pizza', quantity: 1 },
          { menuItemId: knotsId, name: 'Garlic knots', quantity: 2, viaUpsell: true },
        ],
        customerName: 'Gray',
      },
    });
    expect(res.statusCode).toBe(201);
    // 1800 + 2×599 — the flag changed nothing about the money.
    expect(res.json().totalCents).toBe(2998);

    const items = await prisma.orderItem.findMany({
      where: { order: { callId } },
      select: { name: true, viaUpsell: true, unitPriceCents: true },
      orderBy: { name: 'asc' },
    });
    expect(items).toEqual([
      { name: 'Garlic knots', viaUpsell: true, unitPriceCents: 599 },
      { name: 'Large cheese pizza', viaUpsell: false, unitPriceCents: 1800 },
    ]);
  });

  it('counts upsell revenue from the stored lines', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/loyalty-stats`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    // The 2 × $5.99 knots from the order above, and nothing else.
    expect(res.json().last30Days.upsellRevenueCents).toBe(1198);
    expect(res.json().last30Days.upsellItems).toBe(1);
  });
});

describe.skipIf(!dbUp)('Recording playback', () => {
  let app: App;
  let appNoStorage: App;
  let locationId: string;
  let userId: string | undefined;
  const callIds: string[] = [];
  const NUMBER = '+15185550135';
  const EMAIL = `playback-owner-${Date.now()}@brayz.test`;
  const headers = { 'x-brayz-user-email': EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

  async function callWithRecording(url: string | null): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551919', toNumber: NUMBER },
    });
    const id = res.json().id as string;
    callIds.push(id);
    if (url) {
      await prisma.call.update({
        where: { id },
        data: { recordingUrl: url, recordingStatus: 'uploaded' },
      });
    }
    return id;
  }

  beforeAll(async () => {
    const storage = new S3RecordingStorage({
      endpoint: 'https://storage.example.com',
      region: 'us-east-1',
      accessKey: 'AKIAEXAMPLE',
      secretKey: 'shhh',
    });
    app = await buildApp({ notifier: null, recordingStorage: storage });
    appNoStorage = await buildApp({ notifier: null, recordingStorage: null });

    await prisma.phoneNumber.deleteMany({ where: { e164Number: NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Playback Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: NUMBER },
    });
    const user = await prisma.user.create({ data: { email: EMAIL, authSubject: EMAIL } });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    for (const id of callIds) {
      await prisma.auditLog.deleteMany({ where: { targetId: id } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.phoneNumber.deleteMany({ where: { e164Number: NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await appNoStorage.close();
    await prisma.$disconnect();
  });

  it('hands back a signed URL a browser can play', async () => {
    const callId = await callWithRecording('s3://call-recordings/2026-08-27/siphon-x');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.playbackUrl).toContain('https://storage.example.com/call-recordings/');
    expect(body.playbackUrl).toContain('X-Amz-Signature=');
    // Short-lived on purpose: this is a privacy artefact, not a public asset.
    expect(body.expiresInSeconds).toBeLessThanOrEqual(3600);

    // Still audited, exactly as before playback existed (rule #6).
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'recording.accessed', targetId: callId },
    });
    expect(audit).toBeTruthy();
  });

  it('says so plainly when Brayz has no credentials for the bucket', async () => {
    const callId = await callWithRecording('s3://call-recordings/2026-08-27/siphon-y');
    const res = await appNoStorage.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    // The recording exists and we say where — we just cannot play it.
    expect(res.json().playbackUrl).toBeNull();
    expect(res.json().url).toBe('s3://call-recordings/2026-08-27/siphon-y');
  });

  it('offers no playback for a URI it cannot parse', async () => {
    const callId = await callWithRecording('file:///var/lib/siphon/rec.wav');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().playbackUrl).toBeNull();
  });

  it('404s a call with no recording at all', async () => {
    const callId = await callWithRecording(null);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/recording`,
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});
