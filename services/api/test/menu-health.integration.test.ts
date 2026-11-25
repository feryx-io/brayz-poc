import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `health-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const ownerHeaders = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
};

/**
 * The health route end to end: a menu with a calzone that promises toppings,
 * a recorded ask, and the fix applied back through the ordinary menu routes
 * the way the dashboard does it — after which the finding is gone.
 */
describe.skipIf(!dbUp)('Menu health route', () => {
  let app: App;
  let locationId: string;
  let otherLocationId: string;
  let ownerUserId: string | undefined;
  let calzoneId: string;
  let pizzaGroupId: string;

  const health = (loc = locationId, q = '') =>
    app.inject({ method: 'GET', url: `/v1/locations/${loc}/menu-health${q}`, headers: ownerHeaders });

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    ownerUserId = user.id;
    await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' } });

    const [a, b] = await Promise.all([
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Health Kitchen' }, select: { id: true } }),
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Health Kitchen B' }, select: { id: true } }),
    ]);
    locationId = a.id;
    otherLocationId = b.id;

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Health Menu', active: true },
      select: { id: true },
    });
    const pizzaCat = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' }, select: { id: true } });
    const calzCat = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Calzone & Stromboli' },
      select: { id: true },
    });
    const pizza = await prisma.menuItem.create({
      data: { categoryId: pizzaCat.id, name: 'Large Pizza', priceCents: 1900 },
      select: { id: true },
    });
    const group = await prisma.modifierGroup.create({
      data: { menuItemId: pizza.id, name: 'Toppings', selectionType: 'multi', allowsHalves: true },
    });
    pizzaGroupId = group.id;
    for (const [name, priceCents] of [
      ['Pepperoni', 150],
      ['Sausage', 150],
    ] as const) {
      await prisma.modifier.create({ data: { modifierGroupId: group.id, name, priceCents } });
    }
    const calzone = await prisma.menuItem.create({
      data: {
        categoryId: calzCat.id,
        name: 'Calzone',
        priceCents: 1150,
        description: 'Ricotta & mozzarella with pizza toppings of your choice - toppings $1 each',
      },
      select: { id: true },
    });
    calzoneId = calzone.id;
    // A caller asked for sausage on it, last week.
    await prisma.menuGap.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        kind: 'option',
        term: 'sausage',
        rawTerm: 'sausage',
        onItem: 'Calzone',
        createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      },
    });
    // And one ages ago, outside any sensible window.
    await prisma.menuGap.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        kind: 'option',
        term: 'anchovies',
        rawTerm: 'anchovies',
        onItem: 'Calzone',
        createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
      },
    });
  });

  afterAll(async () => {
    await prisma.menuGap.deleteMany({ where: { locationId } }).catch(() => {});
    for (const id of [locationId, otherLocationId]) {
      await prisma.location.deleteMany({ where: { id } }).catch(() => {});
    }
    if (ownerUserId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: ownerUserId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: ownerUserId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('finds the promised-but-missing group and the recent ask, not the stale one', async () => {
    const res = await health();
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: number;
      findings: Array<{ id: string; code: string; fix?: unknown; evidence: { count?: number; samples?: string[] } }>;
    };
    expect(body.days).toBe(30);
    const promised = body.findings.find((f) => f.code === 'options_promised_no_group')!;
    expect(promised).toBeDefined();
    // The sausage ask is evidence on that finding, not a second fix beside it;
    // the anchovies ask is too old to count.
    expect(promised.evidence).toMatchObject({ count: 1, samples: ['sausage'] });
    expect(body.findings.some((f) => f.code === 'option_asked_not_offered')).toBe(false);
    // Widened, the old ask counts too.
    const wide = await health(locationId, '?days=365');
    const widePromised = wide.json().findings.find((f: { code: string }) => f.code === 'options_promised_no_group');
    expect(widePromised.evidence.count).toBe(2);
    expect(widePromised.evidence.samples).toContain('anchovies');
  });

  it('is empty for a location with no menu, and never mixes locations', async () => {
    const res = await health(otherLocationId);
    expect(res.statusCode).toBe(200);
    expect(res.json().findings).toEqual([]);
  });

  it('applying the fix through the menu routes clears the finding', async () => {
    const before = await health();
    const finding = (before.json().findings as Array<{ code: string; fix: Record<string, unknown> }>).find(
      (f) => f.code === 'options_promised_no_group',
    )!;
    const fix = finding.fix as {
      kind: string;
      itemId: string;
      name: string;
      selectionType: string;
      required: boolean;
      modifiers: Array<{ name: string; priceCents: number }>;
    };
    expect(fix.kind).toBe('create_group');
    expect(fix.itemId).toBe(calzoneId);
    expect(fix.modifiers).toEqual([
      { name: 'Pepperoni', priceCents: 100 },
      { name: 'Sausage', priceCents: 100 },
    ]);

    // What the dashboard does: the same routes the editor uses.
    const group = await app.inject({
      method: 'POST',
      url: `/v1/menu/items/${fix.itemId}/modifier-groups`,
      headers: ownerHeaders,
      payload: { name: fix.name, selectionType: fix.selectionType, required: fix.required },
    });
    expect(group.statusCode).toBe(201);
    // A calzone's toppings default to whole, even copied from a pizza.
    expect(group.json().allowsHalves).toBe(false);
    for (const m of fix.modifiers) {
      const r = await app.inject({
        method: 'POST',
        url: `/v1/menu/modifier-groups/${group.json().id}/modifiers`,
        headers: ownerHeaders,
        payload: m,
      });
      expect(r.statusCode).toBe(201);
    }

    const after = await health();
    const codes = (after.json().findings as Array<{ code: string }>).map((f) => f.code);
    expect(codes).not.toContain('options_promised_no_group');
    // The sausage ask is answered by the same edit.
    expect(codes).not.toContain('option_asked_not_offered');
  });

  it('flags a pizza whose halves were switched off, and the switch fixes it', async () => {
    await prisma.modifierGroup.update({ where: { id: pizzaGroupId }, data: { allowsHalves: false } });
    const res = await health();
    const f = (res.json().findings as Array<{ code: string; fix?: { kind: string; groupId: string } }>).find(
      (x) => x.code === 'pizza_halves_off',
    );
    expect(f?.fix).toEqual({ kind: 'allow_halves', groupId: pizzaGroupId });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/menu/modifier-groups/${pizzaGroupId}`,
      headers: ownerHeaders,
      payload: { allowsHalves: true },
    });
    expect(patch.statusCode).toBe(200);
    const again = await health();
    expect((again.json().findings as Array<{ code: string }>).some((x) => x.code === 'pizza_halves_off')).toBe(false);
  });
});
