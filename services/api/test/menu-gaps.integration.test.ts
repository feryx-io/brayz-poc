import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550140';
const OWNER_EMAIL = `gaps-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { normalizeGapTerm } = await import('../src/routes/tools.js');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET, 'content-type': 'application/json' };
const ownerHeaders = { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT };

describe('normalizeGapTerm', () => {
  it('counts one thing once however it was said', () => {
    for (const said of ['Ketchup', 'ketchup!', '  KETCHUP ', 'a ketchup', 'some ketchup', 'side of ketchup']) {
      expect(normalizeGapTerm(said)).toBe('ketchup');
    }
    // But two different things stay two things.
    expect(normalizeGapTerm('honey mustard')).toBe('honey mustard');
    expect(normalizeGapTerm('mustard')).toBe('mustard');
  });
});

/**
 * Requests the menu could not satisfy, and the count a restaurant sees.
 *
 * Every row is a caller who was told "we don't have that" — evidence the
 * restaurant otherwise never gets. The engine computed it, said it, and forgot.
 */
describe.skipIf(!dbUp)('menu gaps', () => {
  let app: App;
  let locationId: string;
  let callId: string;
  let userId: string | undefined;

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Gap Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const user = await prisma.user.create({
      data: { authSubject: `dev|${OWNER_EMAIL}`, email: OWNER_EMAIL },
      select: { id: true },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
    const call = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551515', toNumber: TEST_NUMBER },
    });
    callId = call.json().id as string;
  });

  afterAll(async () => {
    await prisma.menuGap.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.call.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
  });

  const record = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/v1/calls/${callId}/tools/menu-gap`, headers: nodeHeaders, payload });

  const read = () =>
    app.inject({ method: 'GET', url: `/v1/locations/${locationId}/menu-gaps`, headers: ownerHeaders });

  it('adds up the askings of one thing and puts the most-asked first', async () => {
    for (const term of ['Ketchup', 'ketchup', 'a ketchup']) {
      expect((await record({ kind: 'item', term })).statusCode).toBe(201);
    }
    expect((await record({ kind: 'item', term: 'Mustard' })).statusCode).toBe(201);

    const rows = read().then((r) => r.json() as Array<{ term: string; count: number; label: string }>);
    const body = await rows;
    expect(body[0]).toMatchObject({ term: 'ketchup', count: 3 });
    // The label is what someone actually said, not the flattened key.
    expect(['Ketchup', 'ketchup', 'a ketchup']).toContain(body[0]!.label);
    expect(body[1]).toMatchObject({ term: 'mustard', count: 1 });
  });

  it('says which item an option was asked for on', async () => {
    await record({ kind: 'option', term: 'ranch', onItem: 'Boneless Wings' });
    await record({ kind: 'option', term: 'ranch', onItem: 'Large Pizza (18")' });
    const body = (await read()).json() as Array<{ term: string; kind: string; onItems: string[] }>;
    const ranch = body.find((g) => g.term === 'ranch')!;
    expect(ranch.kind).toBe('option');
    expect(ranch.onItems.sort()).toEqual(['Boneless Wings', 'Large Pizza (18")']);
  });

  it('ignores a request that normalizes to nothing rather than storing punctuation', async () => {
    const res = await record({ kind: 'item', term: '???' });
    expect(res.statusCode).toBe(204);
    const body = (await read()).json() as Array<{ term: string }>;
    expect(body.some((g) => g.term === '')).toBe(false);
  });

  it('needs the node secret to record and the tenant to read', async () => {
    const noSecret = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/menu-gap`,
      headers: { 'content-type': 'application/json' },
      payload: { kind: 'item', term: 'ketchup' },
    });
    expect(noSecret.statusCode).toBe(401);

    const otherTenant = await prisma.tenant.create({ data: { name: 'Not Theirs' }, select: { id: true } });
    const outsider = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/menu-gaps`,
      headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': otherTenant.id },
    });
    expect([403, 404]).toContain(outsider.statusCode);
    await prisma.tenant.delete({ where: { id: otherTenant.id } });
  });

  it('drops an ask once the menu answers it', async () => {
    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Gap Menu', active: true },
      select: { id: true },
    });
    const cat = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' }, select: { id: true } });
    const calzone = await prisma.menuItem.create({
      data: { categoryId: cat.id, name: 'Calzone', priceCents: 1150 },
      select: { id: true },
    });
    const toppings = await prisma.modifierGroup.create({
      data: { menuItemId: calzone.id, name: 'Toppings', selectionType: 'multi' },
      select: { id: true },
    });
    await prisma.modifier.create({ data: { modifierGroupId: toppings.id, name: 'Sausage', priceCents: 100 } });
    await prisma.menuItem.create({ data: { categoryId: cat.id, name: 'Garlic Knots', priceCents: 600 } });

    // Two toppings asked on the calzone and an item asked for by name, as
    // on the real calls — the menu now has the sausage and the knots.
    await record({ kind: 'option', term: 'Sausage', onItem: 'Calzone' });
    await record({ kind: 'option', term: 'pepperoni', onItem: 'Calzone' });
    await record({ kind: 'item', term: 'garlic knots' });
    let body = (await read()).json() as Array<{ term: string; kind: string }>;
    expect(body.some((g) => g.term === 'sausage')).toBe(false);
    expect(body.some((g) => g.term === 'garlic knots')).toBe(false);
    expect(body.find((g) => g.term === 'pepperoni')).toMatchObject({ kind: 'option' });

    // Add the pepperoni and it goes too — without waiting for the window.
    await prisma.modifier.create({ data: { modifierGroupId: toppings.id, name: 'Pepperoni', priceCents: 100 } });
    body = (await read()).json() as Array<{ term: string }>;
    expect(body.some((g) => g.term === 'pepperoni')).toBe(false);

    // The rows are still on the record; only the card stopped showing them.
    expect(await prisma.menuGap.count({ where: { locationId, term: 'sausage' } })).toBe(1);
    await prisma.menu.deleteMany({ where: { id: menu.id } });
  });

  it('only looks back as far as it is asked to', async () => {
    await prisma.menuGap.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        kind: 'item',
        term: 'eggnog',
        rawTerm: 'eggnog',
        createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      },
    });
    const recent = (await read()).json() as Array<{ term: string }>;
    expect(recent.some((g) => g.term === 'eggnog')).toBe(false);

    const wider = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/menu-gaps?days=120`,
      headers: ownerHeaders,
    });
    expect((wider.json() as Array<{ term: string }>).some((g) => g.term === 'eggnog')).toBe(true);
  });
});
