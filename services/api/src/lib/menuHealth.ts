import { prisma } from '@brayz/db';
import { defaultAllowsHalves, normalizeTerm, type MenuHealthFinding, type MenuHealthFix } from '@brayz/shared';

/**
 * Menu health: what about this menu will make the bot handle a call badly,
 * found from the menu itself and from what callers actually asked for.
 *
 * Every defect found on a real call so far was a menu fact the bot lacked —
 * a calzone whose description promised "toppings $1 each" with no toppings
 * group, so a caller's sausage and pepperoni went to the ticket as free text
 * unpriced; wings with no sauce group, so "BBQ" fell off the order; pizza
 * toppings that could not be split. None of it is visible from the menu
 * editor, and each one cost a call to surface. These checks read the same
 * data and say it up front, with the evidence, and where the fix is a plain
 * menu edit they spell it out so the dashboard can apply it through the same
 * routes the editor uses (rule #5: the fix is an ordinary write, audited and
 * role-gated like any other).
 *
 * Pure: takes a snapshot, returns findings, touches nothing. The route loads
 * the snapshot; tests build one by hand.
 */

export interface SnapshotModifier {
  id: string;
  name: string;
  priceCents: number;
  available: boolean;
}

export interface SnapshotGroup {
  id: string;
  name: string;
  selectionType: string;
  required: boolean;
  allowsHalves: boolean;
  modifiers: SnapshotModifier[];
}

export interface SnapshotItem {
  id: string;
  name: string;
  category: string;
  description: string | null;
  priceCents: number;
  available: boolean;
  groups: SnapshotGroup[];
}

export interface SnapshotGap {
  kind: string;
  term: string;
  rawTerm: string;
  onItem: string | null;
  createdAt: Date;
}

/** A special instruction on an ordered line, with the item it was on. */
export interface SnapshotInstruction {
  menuItemId: string | null;
  itemName: string;
  text: string;
  createdAt: Date;
}

export interface MenuSnapshot {
  items: SnapshotItem[];
  gaps: SnapshotGap[];
  instructions: SnapshotInstruction[];
}

/** Words in a description that promise choices the item then has to offer. */
const PROMISES_OPTIONS = /\b(toppings?|your choice|choice of|choose|add[- ]?ons?|extras?)\b/i;
/** "$1 each", "$1.50 each", "1.00 each" — the price a description names for those choices. */
const EACH_PRICE = /\$?\s*(\d+(?:\.\d{1,2})?)\s*(?:each|ea\.?|per topping)/i;

export function analyzeMenu(snap: MenuSnapshot, now = new Date()): MenuHealthFinding[] {
  const findings: MenuHealthFinding[] = [];
  const items = snap.items;
  const byName = new Map<string, SnapshotItem[]>();
  for (const it of items) {
    const key = normalizeTerm(it.name);
    byName.set(key, [...(byName.get(key) ?? []), it]);
  }
  const itemByName = (name: string) => byName.get(normalizeTerm(name))?.[0];

  /** Every option on the menu, by normalized name, with where it lives. */
  const optionIndex = new Map<string, Array<{ item: SnapshotItem; group: SnapshotGroup; option: SnapshotModifier }>>();
  for (const item of items) {
    for (const group of item.groups) {
      for (const option of group.modifiers) {
        const key = normalizeTerm(option.name);
        optionIndex.set(key, [...(optionIndex.get(key) ?? []), { item, group, option }]);
      }
    }
  }
  const itemHasOption = (item: SnapshotItem, key: string) =>
    item.groups.some((g) => g.modifiers.some((o) => normalizeTerm(o.name) === key));

  // ---- 1. The description promises choices the item does not offer ----
  for (const item of items) {
    if (!item.available || item.groups.length > 0) continue;
    if (!item.description || !PROMISES_OPTIONS.test(item.description)) continue;
    // Only toppings can be copied from a sibling with any confidence: a sub
    // that says "choose cheese + sauce" or a wrap's "your choice of veggies"
    // promises choices this menu spells out nowhere, and a pizza's toppings
    // pasted onto it would be a worse ticket than free text.
    const promisesToppings = /\btoppings?\b/i.test(item.description);
    const donor = promisesToppings ? bestToppingsDonor(item, items) : undefined;
    const each = EACH_PRICE.exec(item.description);
    const priceCents = each ? Math.round(Number(each[1]) * 100) : null;
    const upTo = /\bup to (\d+)\b/i.exec(item.description);
    const maxSelections = upTo ? Number(upTo[1]) : undefined;
    const fix: MenuHealthFix | undefined = donor
      ? {
          kind: 'create_group',
          itemId: item.id,
          name: donor.group.name,
          selectionType: 'multi',
          required: false,
          ...(maxSelections ? { maxSelections } : {}),
          modifiers: donor.group.modifiers
            .filter((o) => o.available)
            .map((o) => ({ name: o.name, priceCents: priceCents ?? o.priceCents })),
        }
      : undefined;
    findings.push({
      id: `options_promised_no_group:${item.id}`,
      code: 'options_promised_no_group',
      severity: fix ? 'fix' : 'warn',
      itemId: item.id,
      itemName: item.name,
      title: `${item.name} promises choices it cannot take`,
      detail:
        `Its description says "${excerpt(item.description)}", but it has no option group, so a caller's ` +
        `choice goes to the ticket as free text, unpriced.` +
        (donor
          ? ` ${donor.item.name} has a ${donor.group.name} group with ${donor.group.modifiers.length} options` +
            (priceCents != null
              ? ` — the fix copies it at the $${(priceCents / 100).toFixed(2)} each the description names`
              : ' — the fix copies it at those prices') +
            (maxSelections ? `, up to ${maxSelections} per order.` : '.')
          : promisesToppings
            ? ' No toppings group exists elsewhere on the menu to copy; add one in the editor.'
            : ' Add a group for those choices in the editor — nothing on the menu spells them out to copy.'),
      evidence: {},
      fix,
    });
  }
  const promised = new Map(
    findings.filter((f) => f.code === 'options_promised_no_group').map((f) => [f.itemId!, f]),
  );

  // ---- 2. Callers asked for an option the item does not have ----
  const optionAsks = new Map<string, { item: SnapshotItem; term: string; label: string; count: number; lastAt: Date }>();
  for (const gap of snap.gaps) {
    if (gap.kind !== 'option' || !gap.onItem) continue;
    const item = itemByName(gap.onItem);
    if (!item) continue;
    const key = `${item.id}|${gap.term}`;
    const seen = optionAsks.get(key);
    if (seen) {
      seen.count += 1;
      if (gap.createdAt > seen.lastAt) {
        seen.lastAt = gap.createdAt;
        seen.label = gap.rawTerm;
      }
    } else optionAsks.set(key, { item, term: gap.term, label: gap.rawTerm, count: 1, lastAt: gap.createdAt });
  }
  // Free text on ordered lines that names an option another item has: the
  // same ask, arriving through a different door.
  for (const ins of snap.instructions) {
    const item = (ins.menuItemId && items.find((i) => i.id === ins.menuItemId)) || itemByName(ins.itemName);
    if (!item) continue;
    const text = normalizeTerm(ins.text);
    // Whole words only, and the longest match wins: "garlic parm" on wings
    // that offer Garlic Parmesan is that sauce, not a request for the calzone's
    // garlic topping. An option the item already has that names the word
    // answers it too.
    const matched = [...optionIndex.keys()].filter((key) => hasWords(text, key));
    for (const key of matched) {
      if (matched.some((other) => other !== key && other.includes(key) && hasWords(other, key))) continue;
      if (itemHasOption(item, key)) continue;
      if (item.groups.some((g) => g.modifiers.some((o) => hasWords(normalizeTerm(o.name), key)))) continue;
      const homes = optionIndex.get(key)!;
      const name = homes[0]!.option.name;
      const k = `${item.id}|${key}`;
      const seen = optionAsks.get(k);
      if (seen) {
        seen.count += 1;
        if (ins.createdAt > seen.lastAt) seen.lastAt = ins.createdAt;
      } else optionAsks.set(k, { item, term: key, label: name, count: 1, lastAt: ins.createdAt });
    }
  }
  for (const ask of optionAsks.values()) {
    if (itemHasOption(ask.item, ask.term)) continue; // added since it was asked
    // An item already flagged for having no group at all: the asks are the
    // evidence for that one finding, not a second fix competing with it.
    const parent = promised.get(ask.item.id);
    if (parent) {
      parent.evidence.count = (parent.evidence.count ?? 0) + ask.count;
      parent.evidence.samples = [...(parent.evidence.samples ?? []), ask.label];
      if (!parent.evidence.lastAt || ask.lastAt.toISOString() > parent.evidence.lastAt) {
        parent.evidence.lastAt = ask.lastAt.toISOString();
      }
      continue;
    }
    const homes = optionIndex.get(ask.term) ?? [];
    const home = homes.find((h) => h.item.category === ask.item.category) ?? homes[0];
    // Where to put it: the item's own group of the same name as the donor's,
    // else its first multi-select group, else a new group.
    const target =
      (home && ask.item.groups.find((g) => normalizeTerm(g.name) === normalizeTerm(home.group.name))) ??
      ask.item.groups.find((g) => g.selectionType === 'multi');
    const fix: MenuHealthFix | undefined = home
      ? target
        ? { kind: 'add_modifier', groupId: target.id, name: home.option.name, priceCents: home.option.priceCents }
        : {
            kind: 'create_group',
            itemId: ask.item.id,
            name: home.group.name,
            selectionType: home.group.selectionType === 'single' ? 'single' : 'multi',
            required: false,
            modifiers: [{ name: home.option.name, priceCents: home.option.priceCents }],
          }
      : undefined;
    findings.push({
      id: `option_asked_not_offered:${ask.item.id}:${ask.term}`,
      code: 'option_asked_not_offered',
      severity: home ? 'fix' : 'warn',
      itemId: ask.item.id,
      itemName: ask.item.name,
      title: `Callers ask for ${ask.label} on ${ask.item.name}`,
      detail:
        `${ask.count} time${ask.count === 1 ? '' : 's'} in the period, most recently ${daysAgo(ask.lastAt, now)}. ` +
        (home
          ? `${home.item.name} offers ${home.option.name}${home.option.priceCents ? ` at $${(home.option.priceCents / 100).toFixed(2)}` : ' at no charge'}; ` +
            (target ? `the fix adds it to ${ask.item.name}'s ${target.name}.` : `the fix gives ${ask.item.name} a ${home.group.name} group with it.`)
          : `Nothing on the menu offers it, so the bot notes it as a request and cannot price it.`),
      evidence: { count: ask.count, lastAt: ask.lastAt.toISOString() },
      fix,
    });
  }

  for (const f of promised.values()) {
    if (!f.evidence.count) continue;
    f.detail += ` Callers have asked for ${f.evidence.samples!.join(', ')} on it ${f.evidence.count} time${
      f.evidence.count === 1 ? '' : 's'
    } in the period.`;
  }

  // ---- 3. Two items with the same name ----
  for (const [, dupes] of byName) {
    if (dupes.length < 2) continue;
    const first = dupes[0]!;
    findings.push({
      id: `duplicate_item:${dupes.map((d) => d.id).sort().join('+')}`,
      code: 'duplicate_item',
      severity: 'warn',
      itemId: first.id,
      itemName: first.name,
      title: `"${first.name}" appears ${dupes.length} times`,
      detail:
        dupes.map((d) => `${d.category} at $${(d.priceCents / 100).toFixed(2)}${d.groups.length ? '' : ', no options'}`).join('; ') +
        '. The bot has to guess which one a caller means. Keep one, or rename them so they differ.',
      evidence: { samples: dupes.map((d) => d.id) },
    });
  }

  // ---- 4. Pizza toppings that cannot be split ----
  for (const item of items) {
    for (const group of item.groups) {
      if (group.allowsHalves) continue;
      if (!defaultAllowsHalves({ name: item.name, category: item.category }, group)) continue;
      findings.push({
        id: `pizza_halves_off:${group.id}`,
        code: 'pizza_halves_off',
        severity: 'fix',
        itemId: item.id,
        itemName: item.name,
        groupId: group.id,
        title: `${item.name} cannot be ordered half-and-half`,
        detail: `Its ${group.name} group does not allow halves, so "half pepperoni, half sausage" is refused. The fix turns halves on at the full topping price per half.`,
        evidence: {},
        fix: { kind: 'allow_halves', groupId: group.id },
      });
    }
  }

  // ---- 5. A group with nothing in it ----
  for (const item of items) {
    for (const group of item.groups) {
      if (group.modifiers.some((o) => o.available)) continue;
      findings.push({
        id: `group_without_options:${group.id}`,
        code: 'group_without_options',
        severity: group.required ? 'fix' : 'warn',
        itemId: item.id,
        itemName: item.name,
        groupId: group.id,
        title: `${item.name}'s ${group.name} has no options`,
        detail: group.required
          ? 'It is required, so the bot must ask the caller to choose and has nothing to offer. Add options or make it optional.'
          : 'Nothing can be chosen from it. Add options or delete the group.',
        evidence: {},
      });
    }
  }

  // ---- 6. Sold for nothing ----
  for (const item of items) {
    if (!item.available || item.priceCents > 0) continue;
    findings.push({
      id: `item_zero_price:${item.id}`,
      code: 'item_zero_price',
      severity: 'warn',
      itemId: item.id,
      itemName: item.name,
      title: `${item.name} is priced at $0.00`,
      detail: 'The bot will offer it free. Set a price, or mark it unavailable if it is not for sale.',
      evidence: {},
    });
  }

  // ---- 7. Started, not finished ----
  // A template's starter items arrive unpriced and hidden so the bot never
  // quotes a guess. One note for all of them: the owner prices each and
  // switches it on, and the note shrinks as they go.
  const unpriced = items.filter((i) => !i.available && i.priceCents === 0);
  if (unpriced.length) {
    findings.push({
      id: 'starter_items_unpriced',
      code: 'starter_items_unpriced',
      severity: 'info',
      title: `${unpriced.length} item${unpriced.length === 1 ? ' is' : 's are'} hidden until priced`,
      detail:
        'These have no price and are not offered to callers. Set a price on each and mark it available — or delete the ones you do not sell.',
      evidence: { count: unpriced.length, samples: unpriced.slice(0, 8).map((i) => i.name) },
    });
  }

  const rank = { fix: 0, warn: 1, info: 2 } as const;
  return findings.sort(
    (a, b) => rank[a.severity] - rank[b.severity] || (b.evidence.count ?? 0) - (a.evidence.count ?? 0) || a.title.localeCompare(b.title),
  );
}

/**
 * The toppings-like group most like what this item is missing. Same category
 * first; then the same kind of thing — a pizza copies from a pizza, whatever
 * section it sits in. On the real menu the "Specialty Pizza" section had no
 * toppings group of its own, and the fallback handed three pizzas the
 * calzone's $1.00 toppings where every pizza on the menu charges $1.50–$3.00.
 */
function bestToppingsDonor(item: SnapshotItem, items: SnapshotItem[]) {
  const candidates = items
    .filter((i) => i.id !== item.id)
    .flatMap((i) => i.groups.filter((g) => g.selectionType === 'multi' && /topping|add|extra/i.test(g.name)).map((group) => ({ item: i, group })))
    .filter((c) => c.group.modifiers.some((o) => o.available));
  const isPizza = (i: SnapshotItem) => /pizza/i.test(i.name) || /pizza/i.test(i.category);
  const largest = (list: typeof candidates) => [...list].sort((a, b) => b.group.modifiers.length - a.group.modifiers.length)[0];
  return (
    candidates.find((c) => c.item.category === item.category) ??
    (isPizza(item) ? largest(candidates.filter((c) => isPizza(c.item))) : undefined) ??
    largest(candidates.filter((c) => !isPizza(c.item) || isPizza(item))) ??
    largest(candidates)
  );
}

/** Does `text` contain `phrase` as whole words? Both already normalized. */
function hasWords(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

function excerpt(s: string, max = 80): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function daysAgo(d: Date, now: Date): string {
  const days = Math.floor((now.getTime() - d.getTime()) / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/**
 * Whether the menu now answers a recorded ask: an item of that name is sold,
 * or the item it was asked on now has an option of that name. A gap is a
 * fact about a call, not about the menu — once the owner adds the thing,
 * the next caller gets it, and listing it as missing would be wrong. The
 * same test menu health applies before it raises a finding.
 */
export function gapCovered(
  items: Array<Pick<SnapshotItem, 'name' | 'groups'>>,
  gap: { kind: string; term: string; onItem: string | null },
): boolean {
  if (gap.kind === 'item') return items.some((i) => normalizeTerm(i.name) === gap.term);
  if (!gap.onItem) return false;
  const item = items.find((i) => normalizeTerm(i.name) === normalizeTerm(gap.onItem!));
  return !!item && item.groups.some((g) => g.modifiers.some((o) => normalizeTerm(o.name) === gap.term));
}

/** The active menu's items with their groups and options, flattened. Tenant and location in the query (rule #1). */
export async function loadMenuItems(tenantId: string, locationId: string): Promise<SnapshotItem[]> {
  const menu = await prisma.menu.findFirst({
    where: { tenantId, locationId, active: true },
    select: {
      categories: {
        select: {
          name: true,
          items: {
            select: {
              id: true,
              name: true,
              description: true,
              priceCents: true,
              available: true,
              modifierGroups: {
                select: {
                  id: true,
                  name: true,
                  selectionType: true,
                  required: true,
                  allowsHalves: true,
                  modifiers: { select: { id: true, name: true, priceCents: true, available: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  return (menu?.categories ?? []).flatMap((c) =>
    c.items.map((i) => ({
      id: i.id,
      name: i.name,
      category: c.name,
      description: i.description,
      priceCents: i.priceCents,
      available: i.available,
      groups: i.modifierGroups,
    })),
  );
}

/**
 * The snapshot the checks run over, for one location: its active menu, the
 * period's recorded asks, and the period's order free text. Tenant and
 * location are both in every query (rule #1).
 */
export async function loadMenuSnapshot(tenantId: string, locationId: string, since: Date): Promise<MenuSnapshot> {
  const [items, gaps, instructions] = await Promise.all([
    loadMenuItems(tenantId, locationId),
    prisma.menuGap.findMany({
      where: { tenantId, locationId, createdAt: { gte: since } },
      select: { kind: true, term: true, rawTerm: true, onItem: true, createdAt: true },
    }),
    prisma.orderItem.findMany({
      where: {
        specialInstructions: { not: null },
        order: { tenantId, locationId, createdAt: { gte: since } },
      },
      select: {
        menuItemId: true,
        name: true,
        specialInstructions: true,
        order: { select: { createdAt: true } },
      },
      orderBy: { order: { createdAt: 'desc' } },
      take: 2000,
    }),
  ]);
  return {
    items,
    gaps,
    instructions: instructions.map((r) => ({
      menuItemId: r.menuItemId,
      itemName: r.name,
      text: r.specialInstructions ?? '',
      createdAt: r.order.createdAt,
    })),
  };
}

