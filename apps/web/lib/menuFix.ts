import type { MenuFixGroup, MenuHealthFix, MenuTree } from './queries';

type Api = <T>(path: string, opts?: { method?: string; body?: unknown }) => Promise<T>;

/**
 * Apply a menu fix — from the Menu health card or an assistant proposal — by
 * calling the same routes the menu editor uses. That is the whole point: a
 * fix is an ordinary edit, role-gated and audited like one, and the API never
 * writes on a finding's or the assistant's say-so.
 *
 * The build-mode kinds name a section rather than pointing at an id, since
 * it may not exist yet; they need the location to create under.
 */
export async function applyMenuFix(api: Api, fix: MenuHealthFix, locationId: string): Promise<void> {
  switch (fix.kind) {
    case 'create_category':
      await api(`/v1/locations/${locationId}/menu/categories`, { method: 'POST', body: { name: fix.name } });
      return;
    case 'create_item': {
      const categoryId = await ensureCategory(api, locationId, fix.category);
      // No price given: created hidden and unpriced, the way a template's
      // starter item is, so the bot never offers a guess. Menu health lists
      // it until the owner prices and enables it.
      const item = await api<{ id: string }>(`/v1/locations/${locationId}/menu/items`, {
        method: 'POST',
        body: {
          categoryId,
          name: fix.name,
          ...(fix.description ? { description: fix.description } : {}),
          ...(fix.ingredients?.length ? { ingredients: fix.ingredients } : {}),
          priceCents: fix.priceCents ?? 0,
          available: fix.priceCents !== undefined,
        },
      });
      for (const g of fix.groups) await createGroup(api, item.id, g);
      return;
    }
    case 'allow_halves':
      await api(`/v1/menu/modifier-groups/${fix.groupId}`, { method: 'PATCH', body: { allowsHalves: true } });
      return;
    case 'add_modifier':
      await api(`/v1/menu/modifier-groups/${fix.groupId}/modifiers`, {
        method: 'POST',
        body: { name: fix.name, priceCents: fix.priceCents },
      });
      return;
    case 'update_item': {
      const { itemId, kind: _k, ...patch } = fix;
      await api(`/v1/menu/items/${itemId}`, { method: 'PATCH', body: patch });
      return;
    }
    case 'update_modifier': {
      const { modifierId, kind: _k, ...patch } = fix;
      await api(`/v1/menu/modifiers/${modifierId}`, { method: 'PATCH', body: patch });
      return;
    }
    case 'create_group':
      await createGroup(api, fix.itemId, fix);
      return;
  }
}

async function createGroup(api: Api, itemId: string, g: MenuFixGroup): Promise<void> {
  const group = await api<{ id: string }>(`/v1/menu/items/${itemId}/modifier-groups`, {
    method: 'POST',
    body: {
      name: g.name,
      selectionType: g.selectionType,
      required: g.required,
      ...(g.maxSelections ? { maxSelections: g.maxSelections } : {}),
      ...(g.allowsHalves !== undefined ? { allowsHalves: g.allowsHalves } : {}),
    },
  });
  for (const m of g.modifiers) {
    await api(`/v1/menu/modifier-groups/${group.id}/modifiers`, {
      method: 'POST',
      body: { name: m.name, priceCents: m.priceCents },
    });
  }
}

/** The id of the section with this name, creating it when the menu has none. */
async function ensureCategory(api: Api, locationId: string, name: string): Promise<string> {
  const key = name.trim().toLowerCase();
  const menu = await api<MenuTree | null>(`/v1/locations/${locationId}/menu`).catch(() => null);
  const found = menu?.categories.find((c) => c.name.trim().toLowerCase() === key);
  if (found) return found.id;
  const created = await api<{ id: string }>(`/v1/locations/${locationId}/menu/categories`, {
    method: 'POST',
    body: { name: name.trim() },
  });
  return created.id;
}

/** A fix in the owner's words, for a button or a card. */
export function describeMenuFix(fix: MenuHealthFix): string {
  switch (fix.kind) {
    case 'allow_halves':
      return 'Allow half-and-half on this group';
    case 'add_modifier':
      return `Add ${fix.name}${fix.priceCents ? ` at $${(fix.priceCents / 100).toFixed(2)}` : ''}`;
    case 'create_group':
      return `Add a ${fix.name} group with ${fix.modifiers.length} option${fix.modifiers.length === 1 ? '' : 's'}`;
    case 'create_category':
      return `Add a ${fix.name} section`;
    case 'create_item': {
      const price = fix.priceCents !== undefined ? `at $${(fix.priceCents / 100).toFixed(2)}` : 'unpriced and hidden until you price it';
      const groups = fix.groups.length ? `, with ${fix.groups.map((g) => g.name).join(', ')}` : '';
      return `Add ${fix.name} to ${fix.category} ${price}${groups}`;
    }
    case 'update_item':
      return [
        fix.name !== undefined ? `rename to ${fix.name}` : '',
        fix.priceCents !== undefined ? `price $${(fix.priceCents / 100).toFixed(2)}` : '',
        fix.available !== undefined ? (fix.available ? 'mark available' : 'mark unavailable') : '',
      ]
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase());
    case 'update_modifier':
      return [
        fix.name !== undefined ? `rename to ${fix.name}` : '',
        fix.priceCents !== undefined ? `price $${(fix.priceCents / 100).toFixed(2)}` : '',
        fix.available !== undefined ? (fix.available ? 'mark available' : 'mark unavailable') : '',
      ]
        .filter(Boolean)
        .join(', ')
        .replace(/^./, (c) => c.toUpperCase());
  }
}
