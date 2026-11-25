import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NumberProvisioner } from '@brayz/carriers';

// Dev-mode number provisioning with an injected fake carrier, against the Docker DB.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

// Fake provisioner: deterministic search + provision, no network.
const fake: NumberProvisioner = {
  name: 'fake',
  searchAvailable: async (q) => [
    { e164Number: '+15185550142', friendlyName: '(518) 555-0142', locality: 'Albany', region: q.region ?? 'NY' },
    { e164Number: '+15185550199', friendlyName: '(518) 555-0199', locality: 'Albany', region: 'NY' },
  ],
  provision: async (e164Number) => ({ e164Number, providerNumberId: `PN${e164Number.replace(/\D/g, '')}` }),
};

const OWNER = `numowner-${Date.now()}@brayz.test`;

describe.skipIf(!dbUp)('Phone-number provisioning', () => {
  let app: App;
  let tenantId: string;
  let locationId: string;

  beforeAll(async () => {
    app = await buildApp({ numberProvisioner: fake });
    const tenant = await prisma.tenant.create({ data: { name: 'Number Test Co' } });
    tenantId = tenant.id;
    const loc = await prisma.location.create({
      data: { tenantId, name: 'Number Test — Main', timezone: 'America/New_York' },
    });
    locationId = loc.id;
  });
  afterAll(async () => {
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const headers = () => ({ 'x-brayz-user-email': OWNER, 'x-brayz-tenant-id': tenantId });

  it('searches available numbers by area code', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/numbers/available?areaCode=518', headers: headers() });
    expect(res.statusCode).toBe(200);
    expect(res.json().numbers).toHaveLength(2);
    expect(res.json().numbers[0].e164Number).toBe('+15185550142');
  });

  it('rejects a search with no filters', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/numbers/available', headers: headers() });
    expect(res.statusCode).toBe(400);
  });

  it('provisions a number into a PhoneNumber row routed to this location', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/phone-numbers/provision`,
      headers: headers(),
      payload: { e164Number: '+15185550142' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      e164Number: '+15185550142',
      locationId,
      tenantId,
      provider: 'fake',
      providerNumberId: 'PN15185550142',
      inboundRouteType: 'ai',
      active: true,
    });
  });

  it('is idempotent — a second provision of the same number is rejected (409)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/phone-numbers/provision`,
      headers: headers(),
      payload: { e164Number: '+15185550142' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('blocks a staff (non-manager) member from provisioning (403)', async () => {
    const staffEmail = `numstaff-${Date.now()}@brayz.test`;
    const user = await prisma.user.create({ data: { email: staffEmail, authSubject: `dev:${staffEmail}` } });
    await prisma.userTenantMembership.create({ data: { tenantId, userId: user.id, role: 'staff' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/phone-numbers/provision`,
      headers: { 'x-brayz-user-email': staffEmail, 'x-brayz-tenant-id': tenantId },
      payload: { e164Number: '+15185550199' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 503 when no provisioner is configured', async () => {
    const bare = await buildApp({ numberProvisioner: null });
    const res = await bare.inject({ method: 'GET', url: '/v1/numbers/available?areaCode=518', headers: headers() });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
