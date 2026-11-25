import type { FastifyInstance } from 'fastify';
import {
  CreateMenuCategoryInput,
  CreateMenuItemInput,
  CreateModifierGroupInput,
  CreateModifierInput,
  UpdateModifierGroupInput,
  UpdateModifierInput,
  UpdateMenuCategoryInput,
  UpdateMenuItemInput,
  defaultAllowsHalves,
  MenuHealthQuery,
} from '@brayz/shared';
import { z } from 'zod';
import { forTenant, prisma } from '@brayz/db';
import { notFound, parse } from '../lib/http.js';
import { analyzeMenu, gapCovered, loadMenuItems, loadMenuSnapshot } from '../lib/menuHealth.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export async function menuRoutes(app: FastifyInstance): Promise<void> {
  // Full menu tree for a location.
  app.get('/v1/locations/:locationId/menu', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    const menu = await db.menu.findFirst({
      where: { locationId, active: true },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: {
            items: {
              orderBy: { name: 'asc' },
              include: { modifierGroups: { include: { modifiers: true } } },
            },
          },
        },
      },
    });
    if (!menu) throw notFound('Menu');
    return menu;
  });

  app.post('/v1/locations/:locationId/menu/categories', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const input = parse(CreateMenuCategoryInput, request.body);

    const menu = await ensureMenu(tenantId, locationId);
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: input.name, sortOrder: input.sortOrder },
    });
    return reply.status(201).send(category);
  });

  app.patch('/v1/menu/categories/:categoryId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { categoryId } = request.params as { categoryId: string };
    await assertCategoryInTenant(tenantId, categoryId);
    const input = parse(UpdateMenuCategoryInput, request.body);
    return prisma.menuCategory.update({ where: { id: categoryId }, data: input });
  });

  app.delete('/v1/menu/categories/:categoryId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { categoryId } = request.params as { categoryId: string };
    await assertCategoryInTenant(tenantId, categoryId);
    await prisma.menuCategory.delete({ where: { id: categoryId } });
    return reply.status(204).send();
  });

  app.post('/v1/locations/:locationId/menu/items', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const input = parse(CreateMenuItemInput, request.body);
    await assertCategoryInTenant(tenantId, input.categoryId);

    const { categoryId, ...rest } = input;
    const item = await prisma.menuItem.create({ data: { categoryId, ...rest } });
    return reply.status(201).send(item);
  });

  app.patch('/v1/menu/items/:itemId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { itemId } = request.params as { itemId: string };
    await assertItemInTenant(tenantId, itemId);
    const input = parse(UpdateMenuItemInput, request.body);
    return prisma.menuItem.update({ where: { id: itemId }, data: input });
  });

  app.delete('/v1/menu/items/:itemId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { itemId } = request.params as { itemId: string };
    await assertItemInTenant(tenantId, itemId);
    await prisma.menuItem.delete({ where: { id: itemId } });
    return reply.status(204).send();
  });

  /**
   * What callers asked for that this menu does not sell, most-asked first.
   *
   * Grouped by the normalized term rather than returned raw: the answer the
   * restaurant wants is "ketchup, ten times this week", not ten rows. The
   * newest spelling of each is kept as the label, and the last time it was
   * asked, so a thing that stopped being asked for sorts itself out.
   */
  app.get('/v1/locations/:locationId/menu-gaps', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocationInTenant(tenantId, locationId);
    const { days } = MenuGapQuery.parse(request.query ?? {});
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [items, recorded] = await Promise.all([
      loadMenuItems(tenantId, locationId),
      prisma.menuGap.findMany({
        where: { tenantId, locationId, createdAt: { gte: since } },
        select: { term: true, rawTerm: true, kind: true, onItem: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    // A row is a caller turned down on a past call. Once the menu sells the
    // thing, it is no longer a gap — the card promises the next caller gets
    // it, and that is now true — so it drops off rather than aging out.
    const rows = recorded.filter((r) => !gapCovered(items, r));

    const byTerm = new Map<
      string,
      { term: string; label: string; kind: string; onItems: Set<string>; count: number; lastAskedAt: Date }
    >();
    for (const r of rows) {
      const seen = byTerm.get(r.term);
      if (seen) {
        seen.count += 1;
        if (r.onItem) seen.onItems.add(r.onItem);
      } else {
        byTerm.set(r.term, {
          term: r.term,
          // Rows come newest-first, so the first spelling seen is the newest.
          label: r.rawTerm,
          kind: r.kind,
          onItems: new Set(r.onItem ? [r.onItem] : []),
          count: 1,
          lastAskedAt: r.createdAt,
        });
      }
    }
    return [...byTerm.values()]
      .map(({ onItems, ...rest }) => ({ ...rest, onItems: [...onItems] }))
      .sort((a, b) => b.count - a.count || +b.lastAskedAt - +a.lastAskedAt);
  });

  /**
   * What about this menu will make the bot handle a call badly, with the edit
   * that fixes each where one exists. Read-only: applying a fix is the
   * dashboard calling the ordinary menu routes below.
   */
  app.get('/v1/locations/:locationId/menu-health', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocationInTenant(tenantId, locationId);
    const { days } = MenuHealthQuery.parse(request.query ?? {});
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const findings = analyzeMenu(await loadMenuSnapshot(tenantId, locationId, since));
    return { generatedAt: new Date().toISOString(), days, findings };
  });

  app.post('/v1/menu/items/:itemId/modifier-groups', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { itemId } = request.params as { itemId: string };
    await assertItemInTenant(tenantId, itemId);
    const input = parse(CreateModifierGroupInput, { ...(request.body as object), menuItemId: itemId });
    const { menuItemId, ...rest } = input;
    // Left unsaid, half-and-half follows the item: on for pizza toppings, off
    // for everything else. The editor can flip it either way afterwards.
    if (rest.allowsHalves === undefined) {
      const item = await prisma.menuItem.findUniqueOrThrow({
        where: { id: menuItemId },
        select: { name: true, category: { select: { name: true } } },
      });
      rest.allowsHalves = defaultAllowsHalves(
        { name: item.name, category: item.category.name },
        { name: rest.name, selectionType: rest.selectionType },
      );
    }
    const group = await prisma.modifierGroup.create({ data: { menuItemId, ...rest } });
    return reply.status(201).send(group);
  });

  app.post('/v1/menu/modifier-groups/:groupId/modifiers', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { groupId } = request.params as { groupId: string };
    await assertGroupInTenant(tenantId, groupId);
    const input = parse(CreateModifierInput, {
      ...(request.body as object),
      modifierGroupId: groupId,
    });
    const { modifierGroupId, ...rest } = input;
    const modifier = await prisma.modifier.create({ data: { modifierGroupId, ...rest } });
    return reply.status(201).send(modifier);
  });

  app.patch('/v1/menu/modifier-groups/:groupId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { groupId } = request.params as { groupId: string };
    await assertGroupInTenant(tenantId, groupId);
    const input = parse(UpdateModifierGroupInput, request.body);
    return prisma.modifierGroup.update({ where: { id: groupId }, data: input });
  });

  // Deleting a group takes its options with it (the schema cascades). Orders
  // already placed keep their own copy of what was chosen — order_item_modifiers
  // stores the name and price at the time, so a ticket cannot be rewritten by a
  // later menu edit.
  app.delete('/v1/menu/modifier-groups/:groupId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { groupId } = request.params as { groupId: string };
    await assertGroupInTenant(tenantId, groupId);
    await prisma.modifierGroup.delete({ where: { id: groupId } });
    return reply.status(204).send();
  });

  app.patch('/v1/menu/modifiers/:modifierId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { modifierId } = request.params as { modifierId: string };
    await assertModifierInTenant(tenantId, modifierId);
    const input = parse(UpdateModifierInput, request.body);
    return prisma.modifier.update({ where: { id: modifierId }, data: input });
  });

  app.delete('/v1/menu/modifiers/:modifierId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { modifierId } = request.params as { modifierId: string };
    await assertModifierInTenant(tenantId, modifierId);
    await prisma.modifier.delete({ where: { id: modifierId } });
    return reply.status(204).send();
  });
}

/** Find or create the active menu for a tenant-owned location. */
async function ensureMenu(tenantId: string, locationId: string) {
  const db = forTenant(tenantId);
  const location = await db.location.findFirst({ where: { id: locationId } });
  if (!location) throw notFound('Location');
  const existing = await db.menu.findFirst({ where: { locationId, active: true } });
  if (existing) return existing;
  return db.menu.create({ data: { tenantId, locationId, name: 'Main Menu' } });
}

/** Ownership guards: walk the parent chain back to a tenant-scoped Menu. */
/** The location must belong to the caller's tenant (rule #1). */
async function assertLocationInTenant(tenantId: string, locationId: string) {
  const db = forTenant(tenantId);
  const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!location) throw notFound('Location');
}

async function assertCategoryInTenant(tenantId: string, categoryId: string) {
  const category = await prisma.menuCategory.findUnique({
    where: { id: categoryId },
    select: { menuId: true },
  });
  if (!category) throw notFound('Category');
  const menu = await forTenant(tenantId).menu.findFirst({ where: { id: category.menuId } });
  if (!menu) throw notFound('Category');
}

async function assertItemInTenant(tenantId: string, itemId: string) {
  const item = await prisma.menuItem.findUnique({
    where: { id: itemId },
    select: { categoryId: true },
  });
  if (!item) throw notFound('Menu item');
  await assertCategoryInTenant(tenantId, item.categoryId);
}

async function assertModifierInTenant(tenantId: string, modifierId: string) {
  const modifier = await prisma.modifier.findUnique({
    where: { id: modifierId },
    select: { modifierGroupId: true },
  });
  if (!modifier) throw notFound('Option');
  await assertGroupInTenant(tenantId, modifier.modifierGroupId);
}

async function assertGroupInTenant(tenantId: string, groupId: string) {
  const group = await prisma.modifierGroup.findUnique({
    where: { id: groupId },
    select: { menuItemId: true },
  });
  if (!group) throw notFound('Modifier group');
  await assertItemInTenant(tenantId, group.menuItemId);
}

/** How far back the menu-gap dashboard looks. A month by default. */
const MenuGapQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
