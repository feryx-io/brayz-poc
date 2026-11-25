import { prisma } from '@brayz/db';
import type { UpsellSuggestion } from '@brayz/shared';

/**
 * Upsell suggestions (plan §2 "Menu → Upsell rules").
 *
 * `MenuItem.upsellTags` says what an item pairs *with*: garlic knots tagged
 * "pizza" means "offer these when the order has pizza in it". Matching happens
 * here against the live menu, so the model is handed real items at real prices
 * and never invents an add-on (rule #5).
 */

/** How many to offer. One is the ask; a couple gives the bot a choice. */
const MAX_SUGGESTIONS = 3;

/** Normalize for matching — tags are typed by staff, names come from the menu. */
function norm(s: string): string {
  return s.toLowerCase().trim();
}

export interface OrderContextLine {
  menuItemId?: string | null;
  name: string;
}

/**
 * Add-ons worth offering for what is currently in the order.
 *
 * A tag matches when it appears in the name or the category of something the
 * guest is already buying, which is how a restaurant would describe the pairing
 * out loud ("knots go with pizza") rather than requiring a rules matrix.
 */
export async function upsellsForOrder(
  locationId: string,
  lines: OrderContextLine[],
): Promise<UpsellSuggestion[]> {
  if (!lines.length) return [];

  const items = await prisma.menuItem.findMany({
    where: {
      available: true,
      category: { menu: { locationId, active: true } },
    },
    select: {
      id: true,
      name: true,
      description: true,
      priceCents: true,
      upsellTags: true,
      category: { select: { name: true } },
    },
  });

  const inOrder = new Set(lines.map((l) => l.menuItemId).filter(Boolean) as string[]);
  const byId = new Map(items.map((i) => [i.id, i]));

  // What the guest is buying, as words a tag can match: item names plus the
  // categories those items sit in.
  const context = new Set<string>();
  for (const line of lines) {
    context.add(norm(line.name));
    const item = line.menuItemId ? byId.get(line.menuItemId) : undefined;
    if (item?.category?.name) context.add(norm(item.category.name));
  }

  const matches = items.filter((item) => {
    if (inOrder.has(item.id)) return false; // already buying it
    if (!item.upsellTags.length) return false;
    return item.upsellTags.some((tag) => {
      const t = norm(tag);
      if (!t) return false;
      // Substring both ways: a "pizza" tag should fire on "Large cheese pizza",
      // and a "large cheese pizza" tag on a "Pizza" category.
      return [...context].some((c) => c.includes(t) || t.includes(c));
    });
  });

  // Cheapest first: a small add-on is the one a guest says yes to on the phone.
  return matches
    .sort((a, b) => a.priceCents - b.priceCents)
    .slice(0, MAX_SUGGESTIONS)
    .map((i) => ({
      menuItemId: i.id,
      name: i.name,
      priceCents: i.priceCents,
      description: i.description,
    }));
}
