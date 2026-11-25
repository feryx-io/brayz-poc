import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Adds the wing sauces and pizza toppings to a location's menu as real modifier
 * groups.
 *
 * Why this exists: the Jimmy's menus were imported as flat items, so the
 * choices a caller has to make were only ever prose in an item description or
 * in a sibling item ("Each Topping — $1.50 — Pepperoni, Sausage, …"). With no
 * modifier rows, the bot had nothing to offer and nothing to price: on a live
 * call (2026-08-31) the caller asked for BBQ boneless wings and "barbecue"
 * could not be matched to anything.
 *
 * Every name and price below is copied from the restaurant's own imported menu
 * text — nothing here is invented. The sauce list and topping prices come from
 * the GLENS FALLS import (`Tenders (5)`, `Each Topping`, `Specialty Toppings`),
 * which is where that prose landed; the Saratoga menu carries the same items
 * without it. Same restaurant, same menu.
 *
 * Idempotent (run it as often as you like): groups and options are matched by
 * name within the item, created when missing, and re-priced when they drift.
 *
 *   LOCATION_ID=<uuid> npm --workspace @brayz/db run menu-options
 */

/** Jimmy's wing/tender sauces, from the `Tenders (5)` description. */
const SAUCES = [
  'Ace (Sweet Teriyaki)',
  // The menu writes this as "Buffalo (mild, medium or hot)". A caller picks one
  // heat, so each is its own option rather than a second question.
  'Buffalo (Mild)',
  'Buffalo (Medium)',
  'Buffalo (Hot)',
  'Garlic Parmesan',
  'BBQ',
  'Mango Habanero',
  'Lemon Pepper',
  'Sweet Thai Chili',
];

/** `Each Topping` — $1.50. */
const TOPPINGS = [
  'Pepperoni',
  'Sausage',
  'Onion',
  'Green Pepper',
  'Mushroom',
  'Salami',
  'Ham',
  'Tomato',
  'Pineapple',
  'Artichoke',
  'Garlic',
  'Black Olives',
  'Banana Pepper',
  'Hot Cherry Peppers',
  'Broccoli',
  'Spinach',
  'Basil',
  'Green Olives',
  'Bacon',
  'Hamburger',
  'Roasted Red Pepper',
  'Meatball',
];
const TOPPING_CENTS = 150;

/** `Specialty Toppings` — $3.00. */
const SPECIALTY_TOPPINGS = ['Eggplant', 'Chicken', 'Anchovies', 'Extra Cheese', 'Kielbasa'];
const SPECIALTY_TOPPING_CENTS = 300;

/** Jimmy's Pizza — Saratoga, the location the test calls reach. */
const DEFAULT_LOCATION_ID = '00000000-0000-0000-0000-000000000000';

interface GroupSpec {
  /** Items that get this group, by exact menu name. */
  items: string[];
  name: string;
  selectionType: 'single' | 'multi';
  required?: boolean;
  minSelections?: number;
  maxSelections?: number | null;
  options: Array<{ name: string; priceCents: number }>;
}

const GROUPS: GroupSpec[] = [
  {
    items: ['Boneless Wings', 'Wings', 'Wings (6)', 'Wings (12)', 'Tenders (5)', '10 Wings'],
    name: 'Sauce',
    selectionType: 'single',
    // The kitchen cannot start without it, so the bot must ask.
    required: true,
    minSelections: 1,
    maxSelections: 1,
    options: SAUCES.map((name) => ({ name, priceCents: 0 })),
  },
  {
    // Create-your-own only. A specialty pizza is a recipe, and its toppings are
    // already in its description.
    items: [
      'Small Pizza (12")',
      'Medium Pizza (14")',
      'Large Pizza (18")',
      '14" Gluten Free Pizza',
      'Plain Cheese (12 Inch - 8 Slice Pan Pizza)',
      'Large Cheese Pizza',
      'Large Pepperoni Pizza',
    ],
    name: 'Toppings',
    selectionType: 'multi',
    maxSelections: null,
    options: [
      ...TOPPINGS.map((name) => ({ name, priceCents: TOPPING_CENTS })),
      ...SPECIALTY_TOPPINGS.map((name) => ({ name, priceCents: SPECIALTY_TOPPING_CENTS })),
    ],
  },
];

async function main(): Promise<void> {
  const locationId = process.env.LOCATION_ID ?? DEFAULT_LOCATION_ID;
  const location = await prisma.location.findUnique({
    where: { id: locationId },
    select: { name: true },
  });
  if (!location) throw new Error(`No location ${locationId}`);
  console.log(`Menu options for ${location.name} (${locationId})`);

  for (const spec of GROUPS) {
    for (const itemName of spec.items) {
      const item = await prisma.menuItem.findFirst({
        where: { name: itemName, category: { menu: { locationId, active: true } } },
        select: { id: true, name: true },
      });
      // The two Jimmy's menus and the demo tenant do not carry the same items,
      // so a miss here is expected, not a failure.
      if (!item) continue;

      let group = await prisma.modifierGroup.findFirst({
        where: { menuItemId: item.id, name: spec.name },
        select: { id: true },
      });
      if (!group) {
        group = await prisma.modifierGroup.create({
          data: {
            menuItemId: item.id,
            name: spec.name,
            selectionType: spec.selectionType,
            required: spec.required ?? false,
            minSelections: spec.minSelections ?? 0,
            maxSelections: spec.maxSelections ?? null,
          },
          select: { id: true },
        });
      }

      let added = 0;
      let repriced = 0;
      for (const option of spec.options) {
        const existing = await prisma.modifier.findFirst({
          where: { modifierGroupId: group.id, name: option.name },
          select: { id: true, priceCents: true },
        });
        if (!existing) {
          await prisma.modifier.create({
            data: { modifierGroupId: group.id, name: option.name, priceCents: option.priceCents },
          });
          added += 1;
          continue;
        }
        if (existing.priceCents !== option.priceCents) {
          await prisma.modifier.update({
            where: { id: existing.id },
            data: { priceCents: option.priceCents },
          });
          repriced += 1;
        }
      }
      console.log(
        `  ${item.name} — ${spec.name}: ${added} added, ${repriced} repriced, ` +
          `${spec.options.length - added - repriced} unchanged`,
      );
    }
  }

  // Reported, never deleted: an empty group is someone's half-finished edit in
  // the menu editor, and it is not this script's to throw away.
  const empty = await prisma.modifierGroup.findMany({
    where: { modifiers: { none: {} }, menuItem: { category: { menu: { locationId } } } },
    select: { name: true, menuItem: { select: { name: true } } },
  });
  for (const g of empty) {
    console.log(
      `  NOTE: "${g.menuItem.name}" has an empty group "${g.name}" — no options to offer.`,
    );
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
