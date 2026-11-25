import type { Prisma } from '@prisma/client';
import { defaultAllowsHalves, normalizeTerm, templateGroupsFor, type MenuTemplate } from '@brayz/shared';

type Tx = Prisma.TransactionClient;

export interface TemplateApplyResult {
  categoriesCreated: number;
  itemsCreated: number;
  groupsCreated: number;
  itemsGivenGroups: number;
}

/**
 * Give every item on a menu the template groups its rules say it should
 * have and does not yet have. A group is skipped when the item already has
 * one of the same name, whatever its contents — an owner's own "Toppings"
 * is theirs, and this never edits it. Restricted to `itemIds` when given
 * (the importer passes what it just created).
 */
export async function attachTemplateGroups(
  tx: Tx,
  menuId: string,
  template: MenuTemplate,
  itemIds?: string[],
): Promise<{ groupsCreated: number; itemsGivenGroups: number }> {
  const items = await tx.menuItem.findMany({
    where: { category: { menuId }, ...(itemIds ? { id: { in: itemIds } } : {}) },
    select: {
      id: true,
      name: true,
      category: { select: { name: true } },
      modifierGroups: { select: { name: true } },
    },
  });
  let groupsCreated = 0;
  let itemsGivenGroups = 0;
  for (const item of items) {
    const have = new Set(item.modifierGroups.map((g) => normalizeTerm(g.name)));
    const wanted = templateGroupsFor(template, { name: item.name, category: item.category.name }).filter(
      ({ spec }) => !have.has(normalizeTerm(spec.name)),
    );
    if (!wanted.length) continue;
    itemsGivenGroups += 1;
    for (const { spec } of wanted) {
      const allowsHalves =
        spec.allowsHalves ??
        defaultAllowsHalves({ name: item.name, category: item.category.name }, { name: spec.name, selectionType: spec.selectionType });
      await tx.modifierGroup.create({
        data: {
          menuItemId: item.id,
          name: spec.name,
          selectionType: spec.selectionType,
          required: spec.required,
          minSelections: spec.minSelections ?? (spec.required ? 1 : 0),
          maxSelections: spec.maxSelections ?? (spec.selectionType === 'single' ? 1 : undefined),
          allowsHalves,
          halfPricing: spec.halfPricing ?? 'full',
          modifiers: { create: spec.options.map((o) => ({ name: o.name, priceCents: o.priceCents })) },
        },
      });
      groupsCreated += 1;
    }
  }
  return { groupsCreated, itemsGivenGroups };
}

/**
 * Lay a template onto a menu. Sections are matched by name so a second
 * apply, or an apply onto a menu that already has a "Pizza" section, adds
 * to it rather than beside it; starter items are skipped where an item of
 * the same name exists anywhere on the menu. Starter items are created with
 * no price and hidden — the bot never offers a template's guess — and the
 * menu-health nudge lists them until the owner prices and enables each.
 * Then every item on the menu, old and new, gets the groups it is missing.
 */
export async function applyMenuTemplate(
  tx: Tx,
  menuId: string,
  template: MenuTemplate,
  opts: { sections: boolean; starterItems: boolean },
): Promise<TemplateApplyResult> {
  let categoriesCreated = 0;
  let itemsCreated = 0;
  if (opts.sections || opts.starterItems) {
    const existing = await tx.menuCategory.findMany({
      where: { menuId },
      select: { id: true, name: true, sortOrder: true, items: { select: { name: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    const byName = new Map(existing.map((c) => [normalizeTerm(c.name), c.id]));
    const itemNames = new Set(existing.flatMap((c) => c.items.map((i) => normalizeTerm(i.name))));
    let sortOrder = existing.length ? Math.max(...existing.map((c) => c.sortOrder)) + 1 : 0;
    for (const cat of template.categories) {
      let categoryId = byName.get(normalizeTerm(cat.name));
      if (!categoryId) {
        const c = await tx.menuCategory.create({ data: { menuId, name: cat.name, sortOrder: sortOrder++ } });
        categoryId = c.id;
        byName.set(normalizeTerm(cat.name), categoryId);
        categoriesCreated += 1;
      }
      if (!opts.starterItems) continue;
      for (const item of cat.items) {
        if (itemNames.has(normalizeTerm(item.name))) continue;
        itemNames.add(normalizeTerm(item.name));
        await tx.menuItem.create({
          data: {
            categoryId,
            name: item.name,
            description: item.description,
            ingredients: item.ingredients ?? [],
            priceCents: 0,
            available: false,
          },
        });
        itemsCreated += 1;
      }
    }
  }
  const groups = await attachTemplateGroups(tx, menuId, template);
  return { categoriesCreated, itemsCreated, ...groups };
}
