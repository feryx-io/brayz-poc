import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
// Unique to this file (see numbers.test.ts) — no calls are placed here, but the
// constant is claimed so nothing else takes it later.
const TEST_NUMBER = '+15185550139';
const OWNER_EMAIL = `mods-owner-${Date.now()}@brayz.test`;
const OUTSIDER_EMAIL = `mods-outsider-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const headers = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
};
/** A DELETE must not claim a JSON body it does not send — Fastify 400s on it. */
const headersNoBody = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
};

/**
 * Editing and removing modifier groups and their options.
 *
 * They could only ever be created. A restaurant setting up "Dip (included):
 * Ranch, Blue Cheese" on its wings had no way to fix a typo, change a price,
 * drop an option it no longer offers, or remove the group — the menu editor
 * showed no controls because the API had none to call.
 */
describe.skipIf(!dbUp)('modifier groups and options can be edited and removed', () => {
  let app: App;
  let locationId: string;
  let itemId: string;
  let userId: string | undefined;
  let outsiderUserId: string | undefined;
  let otherTenantId: string | undefined;

  beforeAll(async () => {
    app = await buildApp({ notifier: null });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Modifier Test Kitchen' },
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

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Modifier Test Menu', active: true },
      select: { id: true },
    });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Starters' },
      select: { id: true },
    });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Boneless Wings', priceCents: 1250 },
      select: { id: true },
    });
    itemId = item.id;
  });

  afterAll(async () => {
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    if (outsiderUserId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: outsiderUserId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: outsiderUserId } }).catch(() => {});
    }
    if (otherTenantId) await prisma.tenant.deleteMany({ where: { id: otherTenantId } }).catch(() => {});
  });

  async function makeGroup(name = 'Dip') {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/menu/items/${itemId}/modifier-groups`,
      headers,
      payload: { name, selectionType: 'single', required: true },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  async function makeOption(groupId: string, name: string, priceCents = 0) {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/menu/modifier-groups/${groupId}/modifiers`,
      headers,
      payload: { name, priceCents },
    });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('renames a group and changes whether it must be chosen', async () => {
    const groupId = await makeGroup('Dip');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/menu/modifier-groups/${groupId}`,
      headers,
      payload: { name: 'Dip (included)', required: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Dip (included)', required: false });
  });

  it('renames an option and reprices it', async () => {
    const groupId = await makeGroup();
    const optionId = await makeOption(groupId, 'Blu Cheese');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/menu/modifiers/${optionId}`,
      headers,
      payload: { name: 'Blue Cheese', priceCents: 100 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Blue Cheese', priceCents: 100 });
  });

  it('removes one option and leaves the rest of the group alone', async () => {
    const groupId = await makeGroup();
    const ranch = await makeOption(groupId, 'Ranch');
    const blue = await makeOption(groupId, 'Blue Cheese');

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/menu/modifiers/${ranch}`,
      headers: headersNoBody,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.modifier.findUnique({ where: { id: ranch } })).toBeNull();
    expect(await prisma.modifier.findUnique({ where: { id: blue } })).not.toBeNull();
  });

  it('removes a group and takes its options with it', async () => {
    const groupId = await makeGroup();
    const optionId = await makeOption(groupId, 'Ranch');

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/menu/modifier-groups/${groupId}`,
      headers: headersNoBody,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.modifierGroup.findUnique({ where: { id: groupId } })).toBeNull();
    // Cascade, not an orphan: an option whose group is gone would still be
    // offered by the menu the engine loads.
    expect(await prisma.modifier.findUnique({ where: { id: optionId } })).toBeNull();
  });

  it('leaves an order that already chose the option exactly as it was', async () => {
    // order_item_modifiers keeps its own name and price, so a menu edit cannot
    // rewrite a ticket after the fact.
    const groupId = await makeGroup();
    const optionId = await makeOption(groupId, 'Ranch');
    const order = await prisma.order.create({
      data: { tenantId: SEEDED_TENANT, locationId, subtotalCents: 1250, totalCents: 1250 },
      select: { id: true },
    });
    const line = await prisma.orderItem.create({
      data: { orderId: order.id, name: 'Boneless Wings', quantity: 1, unitPriceCents: 1250 },
      select: { id: true },
    });
    await prisma.orderItemModifier.create({
      data: { orderItemId: line.id, modifierId: optionId, name: 'Ranch', priceCents: 0 },
    });

    await app.inject({
      method: 'DELETE',
      url: `/v1/menu/modifier-groups/${groupId}`,
      headers: headersNoBody,
    });

    const kept = await prisma.orderItemModifier.findFirst({ where: { orderItemId: line.id } });
    expect(kept).toMatchObject({ name: 'Ranch', priceCents: 0 });
    await prisma.order.delete({ where: { id: order.id } });
  });

  it('will not let another tenant edit or delete them', async () => {
    const groupId = await makeGroup();
    const optionId = await makeOption(groupId, 'Ranch');

    const otherTenant = await prisma.tenant.create({
      data: { name: 'Somebody Else' },
      select: { id: true },
    });
    otherTenantId = otherTenant.id;
    const outsider = await prisma.user.create({
      data: { authSubject: `dev|${OUTSIDER_EMAIL}`, email: OUTSIDER_EMAIL },
      select: { id: true },
    });
    outsiderUserId = outsider.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: otherTenant.id, userId: outsider.id, role: 'owner' },
    });
    const outsiderBase = {
      'x-brayz-user-email': OUTSIDER_EMAIL,
      'x-brayz-tenant-id': otherTenant.id,
    };

    for (const call of [
      { method: 'PATCH' as const, url: `/v1/menu/modifier-groups/${groupId}`, payload: { name: 'Theirs' } },
      { method: 'DELETE' as const, url: `/v1/menu/modifier-groups/${groupId}` },
      { method: 'PATCH' as const, url: `/v1/menu/modifiers/${optionId}`, payload: { name: 'Theirs' } },
      { method: 'DELETE' as const, url: `/v1/menu/modifiers/${optionId}` },
    ]) {
      const res = await app.inject({
        ...call,
        headers: call.payload ? { ...outsiderBase, 'content-type': 'application/json' } : outsiderBase,
      });
      expect(res.statusCode).toBe(404);
    }
    // And it is all still there.
    expect(await prisma.modifier.findUnique({ where: { id: optionId } })).not.toBeNull();
  });
});
