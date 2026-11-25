import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MenuExtractor } from '@brayz/ai';

// Dev-mode menu import with an injected fake extractor, against the Docker DB.
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

const fake: MenuExtractor = {
  name: 'fake',
  extract: async () => ({
    categories: [{ name: 'Pizza', items: [{ name: 'Margherita', priceCents: 1399 }] }],
  }),
};

const OWNER = `menuimp-${Date.now()}@brayz.test`;

describe.skipIf(!dbUp)('AI menu import', () => {
  let app: App;
  let tenantId: string;
  let locationId: string;

  beforeAll(async () => {
    app = await buildApp({ menuExtractor: fake });
    const tenant = await prisma.tenant.create({ data: { name: 'Menu Import Co' } });
    tenantId = tenant.id;
    const loc = await prisma.location.create({
      data: { tenantId, name: 'Import — Main', timezone: 'America/New_York' },
    });
    locationId = loc.id;
  });
  afterAll(async () => {
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const headers = () => ({ 'x-brayz-user-email': OWNER, 'x-brayz-tenant-id': tenantId });

  it('previews an extracted menu from a text field (multipart)', async () => {
    const boundary = '----brayztest';
    const payload = `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nMargherita $13.99\r\n--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/menu/import/preview`,
      headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().menu.categories[0].items[0]).toMatchObject({ name: 'Margherita', priceCents: 1399 });
  });

  it('commits a reviewed menu, creating categories + items', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/menu/import`,
      headers: headers(),
      payload: {
        categories: [
          {
            name: 'Pizza',
            items: [
              { name: 'Margherita', priceCents: 1399, ingredients: ['tomato', 'mozzarella', 'basil'] },
              { name: 'Pepperoni', priceCents: 1599 },
            ],
          },
          { name: 'Drinks', items: [{ name: 'Cola', priceCents: 250 }] },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mode: 'append', added: 3, categoriesCreated: 2 });

    const menu = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/menu`, headers: headers() });
    const data = menu.json() as { categories: Array<{ items: Array<{ name: string; ingredients: string[] }> }> };
    const items = data.categories.flatMap((c) => c.items);
    expect(items.map((i) => i.name)).toEqual(expect.arrayContaining(['Margherita', 'Pepperoni', 'Cola']));
    expect(items.find((i) => i.name === 'Margherita')?.ingredients).toEqual(['tomato', 'mozzarella', 'basil']);
  });

  it('merge updates matching items, adds new, and removes missing', async () => {
    // After the append above the menu has: Pizza{Margherita, Pepperoni}, Drinks{Cola}.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/menu/import`,
      headers: headers(),
      payload: {
        mode: 'merge',
        categories: [
          {
            name: 'Pizza',
            items: [
              { name: 'Margherita', priceCents: 1450, ingredients: ['tomato', 'basil'] }, // updated
              { name: 'Calzone', priceCents: 1700 }, // new
            ],
          },
          // Pepperoni and Cola are absent → removed.
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ mode: 'merge', updated: 1, added: 1, removed: 2 });

    const menu = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/menu`, headers: headers() });
    const items = (menu.json() as { categories: Array<{ items: Array<{ name: string; priceCents: number; ingredients: string[] }> }> })
      .categories.flatMap((c) => c.items);
    expect(items.map((i) => i.name).sort()).toEqual(['Calzone', 'Margherita']);
    const marg = items.find((i) => i.name === 'Margherita');
    expect(marg?.priceCents).toBe(1450);
    expect(marg?.ingredients).toEqual(['tomato', 'basil']);
  });

  it('blocks a staff (non-manager) member from importing (403)', async () => {
    const staffEmail = `impstaff-${Date.now()}@brayz.test`;
    const user = await prisma.user.create({ data: { email: staffEmail, authSubject: `dev:${staffEmail}` } });
    await prisma.userTenantMembership.create({ data: { tenantId, userId: user.id, role: 'staff' } });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/menu/import`,
      headers: { 'x-brayz-user-email': staffEmail, 'x-brayz-tenant-id': tenantId },
      payload: { categories: [{ name: 'X', items: [] }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns 503 for preview when no extractor is configured', async () => {
    const bare = await buildApp({ menuExtractor: null });
    const boundary = '----b';
    const res = await bare.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/menu/import/preview`,
      headers: { ...headers(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\nx\r\n--${boundary}--\r\n`,
    });
    expect(res.statusCode).toBe(503);
    await bare.close();
  });
});
