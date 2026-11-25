import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MenuExtractor } from '@brayz/ai';

// Menu templates against the Docker DB: apply onto an empty menu, onto one
// that already has items, and through the importer.
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

const fake: MenuExtractor = { name: 'fake', extract: async () => ({ categories: [] }) };
const OWNER = `menutpl-${Date.now()}@brayz.test`;
const STAFF = `menutpl-staff-${Date.now()}@brayz.test`;

interface Group {
  name: string;
  selectionType: string;
  required: boolean;
  allowsHalves: boolean;
  modifiers: Array<{ name: string; priceCents: number }>;
}
interface Item {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
  modifierGroups: Group[];
}
interface Tree {
  categories: Array<{ name: string; items: Item[] }>;
}

describe.skipIf(!dbUp)('Menu templates', () => {
  let app: App;
  let tenantId: string;
  let emptyLoc: string;
  let flatLoc: string;
  let importLoc: string;

  beforeAll(async () => {
    app = await buildApp({ menuExtractor: fake, notifier: null });
    const tenant = await prisma.tenant.create({ data: { name: 'Template Co' } });
    tenantId = tenant.id;
    const mk = async (name: string) =>
      (await prisma.location.create({ data: { tenantId, name, timezone: 'America/New_York' } })).id;
    emptyLoc = await mk('Template — empty');
    flatLoc = await mk('Template — flat');
    importLoc = await mk('Template — import');
    // A flat menu as the importer used to make them: items, no groups, plus
    // one item whose owner already built a Toppings group by hand.
    const menu = await prisma.menu.create({ data: { tenantId, locationId: flatLoc, name: 'Main Menu' } });
    const pizza = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza', sortOrder: 0 } });
    const own = await prisma.menuItem.create({ data: { categoryId: pizza.id, name: 'Large Pizza', priceCents: 1800 } });
    await prisma.modifierGroup.create({
      data: {
        menuItemId: own.id,
        name: 'Toppings',
        selectionType: 'multi',
        allowsHalves: true,
        modifiers: { create: [{ name: 'Pepperoni', priceCents: 275 }] },
      },
    });
    await prisma.menuItem.create({ data: { categoryId: pizza.id, name: 'Small Pizza', priceCents: 1200 } });
    await prisma.menuItem.create({ data: { categoryId: pizza.id, name: 'Calzone', priceCents: 1300 } });
    const apps = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Appetizers', sortOrder: 1 } });
    await prisma.menuItem.create({ data: { categoryId: apps.id, name: 'Boneless Wings', priceCents: 1100 } });
    await prisma.menuItem.create({ data: { categoryId: apps.id, name: 'Mozzarella Sticks', priceCents: 800 } });
    const staff = await prisma.user.create({ data: { email: STAFF, authSubject: `dev:${STAFF}` } });
    await prisma.userTenantMembership.create({ data: { userId: staff.id, tenantId, role: 'staff' } });
  });
  afterAll(async () => {
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { in: [OWNER, STAFF] } } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  const headers = (email = OWNER) => ({ 'x-brayz-user-email': email, 'x-brayz-tenant-id': tenantId });
  const tree = async (loc: string): Promise<Tree> =>
    (await app.inject({ method: 'GET', url: `/v1/locations/${loc}/menu`, headers: headers() })).json();
  const item = (t: Tree, name: string) => t.categories.flatMap((c) => c.items).find((i) => i.name === name)!;
  /**
   * An item's option groups by name, sorted. Groups carry no stored order and
   * the menu route does not sort them, so Postgres returns them in whatever
   * order it likes — after the deletes in these tests it sometimes swaps them.
   */
  const groupNames = (i: Tree['categories'][number]['items'][number]) =>
    i.modifierGroups.map((g) => g.name).sort();

  it('lists the templates with what each would create', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/menu-templates', headers: headers() });
    expect(res.statusCode).toBe(200);
    const pizzeria = res.json().templates.find((t: { id: string }) => t.id === 'pizzeria');
    expect(pizzeria.categories.map((c: { name: string }) => c.name)).toContain('Calzones & Stromboli');
    const large = pizzeria.categories.flatMap((c: { items: unknown[] }) => c.items).find(
      (i: { name: string }) => i.name === 'Large Cheese Pizza',
    );
    expect(large.groups).toEqual(['Toppings']);
  });

  it('lays the pizzeria onto an empty location: sections, hidden unpriced starters, groups by rule', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${emptyLoc}/menu/template`,
      headers: headers(),
      payload: { templateId: 'pizzeria' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ templateId: 'pizzeria', categoriesCreated: 12 });
    expect(res.json().itemsCreated).toBeGreaterThan(40);

    const t = await tree(emptyLoc);
    expect(t.categories.map((c) => c.name).slice(0, 3)).toEqual(['Appetizers', 'Salads', 'Wings']);
    const large = item(t, 'Large Cheese Pizza');
    expect(large).toMatchObject({ priceCents: 0, available: false });
    expect(large.modifierGroups).toHaveLength(1);
    expect(large.modifierGroups[0]).toMatchObject({ name: 'Toppings', selectionType: 'multi', allowsHalves: true });
    expect(large.modifierGroups[0]!.modifiers.find((m) => m.name === 'Pepperoni')!.priceCents).toBe(250);
    expect(item(t, 'Small Cheese Pizza').modifierGroups[0]!.modifiers[0]!.priceCents).toBe(150);

    const calzone = item(t, 'Cheese Calzone');
    expect(calzone.modifierGroups.map((g) => g.name)).toEqual(['Fillings']);
    expect(calzone.modifierGroups[0]!.allowsHalves).toBe(false);

    const wings = item(t, 'Wings (10)');
    expect(wings.modifierGroups.map((g) => [g.name, g.required]).sort()).toEqual([
      ['Dip', false],
      ['Sauce', true],
    ]);
    expect(item(t, 'Cannoli').modifierGroups).toEqual([]);

    // The bot must not see any of it until priced.
    const visible = await prisma.menuItem.count({
      where: { available: true, category: { menu: { locationId: emptyLoc } } },
    });
    expect(visible).toBe(0);
  });

  it('a second apply adds nothing: sections, items and groups are matched by name', async () => {
    const before = await tree(emptyLoc);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${emptyLoc}/menu/template`,
      headers: headers(),
      payload: { templateId: 'pizzeria' },
    });
    expect(res.json()).toMatchObject({ categoriesCreated: 0, itemsCreated: 0, groupsCreated: 0 });
    const after = await tree(emptyLoc);
    expect(after.categories.map((c) => c.items.length)).toEqual(before.categories.map((c) => c.items.length));
    expect(item(after, 'Large Cheese Pizza').modifierGroups).toHaveLength(1);
  });

  it('menu health notes the hidden unpriced starters until they are priced and enabled', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/locations/${emptyLoc}/menu-health`, headers: headers() });
    const note = res.json().findings.find((f: { code: string }) => f.code === 'starter_items_unpriced');
    expect(note).toBeDefined();
    expect(note.severity).toBe('info');
    expect(note.evidence.count).toBeGreaterThan(40);
    // No zero-price warnings: hidden items are not "sold for nothing".
    expect(res.json().findings.some((f: { code: string }) => f.code === 'item_zero_price')).toBe(false);
  });

  it('groups-only onto a flat menu: fills the gaps, never touches an owner-built group', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${flatLoc}/menu/template`,
      headers: headers(),
      payload: { templateId: 'pizzeria', sections: false, starterItems: false },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ categoriesCreated: 0, itemsCreated: 0, itemsGivenGroups: 3 });

    const t = await tree(flatLoc);
    expect(t.categories.map((c) => c.name)).toEqual(['Pizza', 'Appetizers']);
    const own = item(t, 'Large Pizza');
    expect(own.modifierGroups).toHaveLength(1);
    expect(own.modifierGroups[0]!.modifiers).toEqual([{ name: 'Pepperoni', priceCents: 275 }].map((m) => expect.objectContaining(m)));
    expect(item(t, 'Small Pizza').modifierGroups[0]).toMatchObject({ name: 'Toppings', allowsHalves: true });
    expect(item(t, 'Calzone').modifierGroups[0]).toMatchObject({ name: 'Fillings', allowsHalves: false });
    expect(groupNames(item(t, 'Boneless Wings'))).toEqual(['Dip', 'Sauce']);
    expect(item(t, 'Mozzarella Sticks').modifierGroups).toEqual([]);
    expect(item(t, 'Small Pizza')).toMatchObject({ priceCents: 1200, available: true });
  });

  it('an import with a template gives the new items their groups and leaves old ones alone', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `/v1/locations/${importLoc}/menu/import`,
      headers: headers(),
      payload: {
        mode: 'append',
        templateId: 'pizzeria',
        categories: [
          { name: 'Pizza', items: [{ name: 'Large Cheese Pizza', priceCents: 1799 }] },
          { name: 'Subs', items: [{ name: 'Italian Sub', priceCents: 999 }] },
        ],
      },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ added: 2, groupsCreated: 3, itemsGivenGroups: 2 });
    let t = await tree(importLoc);
    expect(item(t, 'Large Cheese Pizza').modifierGroups.map((g) => g.name)).toEqual(['Toppings']);
    expect(groupNames(item(t, 'Italian Sub'))).toEqual(['Extras', 'Size']);
    expect(item(t, 'Large Cheese Pizza')).toMatchObject({ priceCents: 1799, available: true });

    // Owner trims the pizza's toppings by hand; a merge re-import must not restore them.
    const toppings = await prisma.modifierGroup.findFirstOrThrow({
      where: { menuItem: { name: 'Large Cheese Pizza', category: { menu: { locationId: importLoc } } } },
    });
    await prisma.modifier.deleteMany({ where: { modifierGroupId: toppings.id, name: { not: 'Pepperoni' } } });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/locations/${importLoc}/menu/import`,
      headers: headers(),
      payload: {
        mode: 'merge',
        templateId: 'pizzeria',
        categories: [
          { name: 'Pizza', items: [{ name: 'Large Cheese Pizza', priceCents: 1899 }] },
          { name: 'Subs', items: [{ name: 'Italian Sub', priceCents: 999 }] },
          { name: 'Wings', items: [{ name: 'Wings (10)', priceCents: 1299 }] },
        ],
      },
    });
    expect(second.json()).toMatchObject({ updated: 2, added: 1, itemsGivenGroups: 1, groupsCreated: 2 });
    t = await tree(importLoc);
    expect(item(t, 'Large Cheese Pizza').modifierGroups[0]!.modifiers).toHaveLength(1);
    expect(groupNames(item(t, 'Wings (10)'))).toEqual(['Dip', 'Sauce']);
  });

  it('an unknown template is 404 and staff cannot apply one', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/locations/${emptyLoc}/menu/template`,
      headers: headers(),
      payload: { templateId: 'sushi' },
    });
    expect(bad.statusCode).toBe(404);
    const staff = await app.inject({
      method: 'POST',
      url: `/v1/locations/${emptyLoc}/menu/template`,
      headers: headers(STAFF),
      payload: { templateId: 'pizzeria' },
    });
    expect(staff.statusCode).toBe(403);
  });

  it('audits the apply with what it created', async () => {
    const rows = await prisma.auditLog.findMany({ where: { tenantId, action: 'menu.template.applied' } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]!.metadata).toMatchObject({ templateId: 'pizzeria' });
  });
});
