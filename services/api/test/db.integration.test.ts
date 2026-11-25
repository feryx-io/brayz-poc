import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point at the local Docker Postgres before importing anything that builds a
// Prisma client. Skips cleanly if the DB isn't reachable.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000ff';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

describe.skipIf(!dbUp)('API + Postgres (live DB)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /v1/locations returns the seeded location for its tenant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    expect(res.statusCode).toBe(200);
    const locations = res.json() as Array<{ name: string }>;
    expect(locations.length).toBeGreaterThanOrEqual(1);
    expect(locations[0]!.name).toContain("Mario's Pizza");
  });

  it('GET menu returns seeded items with prices', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    const locationId = (list.json() as Array<{ id: string }>)[0]!.id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/menu`,
      headers: { 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    expect(res.statusCode).toBe(200);
    const menu = res.json() as { categories: Array<{ items: Array<{ name: string }> }> };
    const itemNames = menu.categories.flatMap((c) => c.items.map((i) => i.name));
    expect(itemNames).toContain('Large Pepperoni Pizza');
  });

  it('enforces tenant isolation — a different tenant sees no locations', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { 'x-brayz-tenant-id': OTHER_TENANT },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('AI settings: defaults then round-trips an update', async () => {
    const locationId = await firstLocationId(app);
    const headers = { 'x-brayz-tenant-id': SEEDED_TENANT };

    // Reset so the "defaults" assertion is independent of prior runs.
    await prisma.locationAiSettings.deleteMany({ where: { locationId } });

    const before = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers,
    });
    expect(before.json()).toMatchObject({ transferEnabled: true, maxCallSeconds: 600 });

    const put = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers,
      payload: { maxCallSeconds: 420, voicePersona: 'tony' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ maxCallSeconds: 420, voicePersona: 'tony' });
  });

  it('phone numbers: create, list, and tenant-scoped delete', async () => {
    const locationId = await firstLocationId(app);
    const headers = { 'x-brayz-tenant-id': SEEDED_TENANT };
    const e164 = `+1518555${Math.floor(1000 + (Date.now() % 9000))}`;

    const created = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/phone-numbers`,
      headers,
      payload: { e164Number: e164 },
    });
    expect(created.statusCode).toBe(201);
    const phoneId = created.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/phone-numbers`,
      headers,
    });
    expect((list.json() as Array<{ id: string }>).some((p) => p.id === phoneId)).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/phone-numbers/${phoneId}`,
      headers,
    });
    expect(del.statusCode).toBe(204);
  });
});

async function firstLocationId(app: App): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/locations',
    headers: { 'x-brayz-tenant-id': SEEDED_TENANT },
  });
  return (res.json() as Array<{ id: string }>)[0]!.id;
}
