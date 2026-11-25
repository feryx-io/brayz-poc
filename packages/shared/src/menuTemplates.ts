import { normalizeTerm } from './domain.js';

/**
 * ---- Menu templates ----
 *
 * A starting menu for a restaurant building one from scratch, and — the part
 * that matters to the bot — a library of option groups with rules for which
 * items get them. Every menu problem found on live calls has been a missing
 * group, not a missing section: wing sauces, pizza toppings, bread on a club,
 * cheese on a sub. A template's sections are a convenience; its groups are
 * what make an imported or hand-built menu orderable by phone.
 *
 * The same rules serve three paths: applying a template to an empty menu,
 * attaching groups to a menu that already has items (a flat import from
 * before), and the importer, which attaches groups to what it just created.
 *
 * Nothing here is a restaurant's fact. Starter items carry no price and are
 * created hidden (`available: false`), so the bot never quotes a template's
 * guess; the owner prices an item and switches it on. Group option prices
 * are typical pizzeria numbers the owner is expected to edit — they exist so
 * a group is usable on day one, not because they are right.
 */

export interface MenuTemplateGroupSpec {
  name: string;
  selectionType: 'single' | 'multi';
  required: boolean;
  minSelections?: number;
  maxSelections?: number;
  /** Omitted: decided per item by `defaultAllowsHalves` (pizza toppings on, else off). */
  allowsHalves?: boolean;
  halfPricing?: 'full' | 'half';
  options: Array<{ name: string; priceCents: number }>;
}

/**
 * Which items get a group. Keywords are matched as whole words against the
 * item's name and its category name together, after `normalizeTerm`, so
 * "Large Cheese Pizza" under "Pizza" and "Cheese Pizza" under "Large Pizzas"
 * both read as a large pizza. `all` must every one appear; `none` must not.
 * Rules run in order and a group name attaches at most once per item, so a
 * more specific rule (small-pizza toppings) is listed before the general one.
 */
export interface MenuTemplateGroupRule {
  all: string[];
  none?: string[];
  groups: string[];
}

export interface MenuTemplateItem {
  name: string;
  description?: string;
  ingredients?: string[];
}

export interface MenuTemplateCategory {
  name: string;
  items: MenuTemplateItem[];
}

export interface MenuTemplate {
  id: string;
  name: string;
  description: string;
  categories: MenuTemplateCategory[];
  groups: Record<string, MenuTemplateGroupSpec>;
  rules: MenuTemplateGroupRule[];
}

const PIZZA_TOPPINGS = [
  'Pepperoni',
  'Sausage',
  'Meatball',
  'Bacon',
  'Ham',
  'Chicken',
  'Anchovies',
  'Mushrooms',
  'Onions',
  'Green Peppers',
  'Black Olives',
  'Tomatoes',
  'Spinach',
  'Broccoli',
  'Jalapeños',
  'Banana Peppers',
  'Pineapple',
  'Garlic',
  'Extra Cheese',
];

const toppings = (priceCents: number): MenuTemplateGroupSpec => ({
  name: 'Toppings',
  selectionType: 'multi',
  required: false,
  halfPricing: 'full',
  options: PIZZA_TOPPINGS.map((name) => ({ name, priceCents })),
});

const WING_SAUCES = ['Plain', 'Mild', 'Medium', 'Hot', 'BBQ', 'Garlic Parmesan', 'Honey BBQ', 'Buffalo'];

const pizzaTemplate: MenuTemplate = {
  id: 'pizzeria',
  name: 'Pizza restaurant',
  description:
    'Build-your-own and specialty pizzas, calzones, subs, wings, dinners and desserts, with toppings (half-and-half on), wing sauces, bread and salad dressing choices set up the way a phone order needs them.',
  categories: [
    {
      name: 'Appetizers',
      items: [
        { name: 'Garlic Bread' },
        { name: 'Garlic Bread with Cheese' },
        { name: 'Mozzarella Sticks' },
        { name: 'Chicken Tenders' },
        { name: 'French Fries' },
        { name: 'Onion Rings' },
        { name: 'Fried Ravioli' },
      ],
    },
    {
      name: 'Salads',
      items: [
        { name: 'Garden Salad' },
        { name: 'Caesar Salad' },
        { name: 'Greek Salad' },
        { name: 'Antipasto Salad' },
        { name: 'Chef Salad' },
      ],
    },
    {
      name: 'Wings',
      items: [
        { name: 'Wings (10)', description: 'Choice of sauce.' },
        { name: 'Wings (20)', description: 'Choice of sauce.' },
        { name: 'Boneless Wings', description: 'Choice of sauce.' },
      ],
    },
    {
      name: 'Pizza',
      items: [
        { name: 'Small Cheese Pizza', description: 'Build your own — add toppings.' },
        { name: 'Medium Cheese Pizza', description: 'Build your own — add toppings.' },
        { name: 'Large Cheese Pizza', description: 'Build your own — add toppings.' },
        { name: 'Sicilian Pizza', description: 'Thick crust, square cut. Add toppings.' },
        { name: 'Gluten-Free Pizza', description: 'Build your own — add toppings.' },
      ],
    },
    {
      name: 'Specialty Pizza',
      items: [
        { name: 'Margherita Pizza', ingredients: ['fresh mozzarella', 'tomato', 'basil'] },
        { name: 'Meat Lovers Pizza', ingredients: ['pepperoni', 'sausage', 'meatball', 'bacon', 'ham'] },
        { name: 'Veggie Pizza', ingredients: ['mushrooms', 'onions', 'green peppers', 'black olives', 'tomatoes'] },
        { name: 'Hawaiian Pizza', ingredients: ['ham', 'pineapple'] },
        { name: 'Buffalo Chicken Pizza', ingredients: ['chicken', 'buffalo sauce', 'mozzarella'] },
        { name: 'White Pizza', ingredients: ['ricotta', 'mozzarella', 'garlic'] },
        { name: 'BBQ Chicken Pizza', ingredients: ['chicken', 'bbq sauce', 'red onion'] },
      ],
    },
    {
      name: 'Calzones & Stromboli',
      items: [
        { name: 'Cheese Calzone', description: 'Ricotta and mozzarella. Add fillings.' },
        { name: 'Stromboli', description: 'Pepperoni, sausage and mozzarella. Add fillings.' },
      ],
    },
    {
      name: 'Subs & Sandwiches',
      items: [
        { name: 'Italian Sub' },
        { name: 'Turkey Sub' },
        { name: 'Ham & Cheese Sub' },
        { name: 'Meatball Parm Sub' },
        { name: 'Chicken Parm Sub' },
        { name: 'Eggplant Parm Sub' },
        { name: 'Philly Cheesesteak' },
        { name: 'Chicken Cutlet Sub' },
      ],
    },
    {
      name: 'Burgers',
      items: [{ name: 'Hamburger' }, { name: 'Cheeseburger' }, { name: 'Bacon Cheeseburger' }],
    },
    {
      name: 'Dinners',
      items: [
        { name: 'Spaghetti & Meatballs' },
        { name: 'Baked Ziti' },
        { name: 'Lasagna' },
        { name: 'Chicken Parmigiana Dinner' },
        { name: 'Eggplant Parmigiana Dinner' },
        { name: 'Fettuccine Alfredo' },
      ],
    },
    {
      name: 'Sides',
      items: [{ name: 'Side of Meatballs' }, { name: 'Side of Sausage' }, { name: 'Side Salad' }],
    },
    {
      name: 'Desserts',
      items: [{ name: 'Cannoli' }, { name: 'Cheesecake' }, { name: 'Tiramisu' }, { name: 'Zeppoles' }],
    },
    {
      name: 'Drinks',
      items: [{ name: '2-Liter Soda' }, { name: '20 oz Soda' }, { name: 'Bottled Water' }],
    },
  ],
  groups: {
    toppings_small: toppings(150),
    toppings_medium: toppings(200),
    toppings_large: toppings(250),
    // A calzone is one folded thing: same list, no halves, one price.
    fillings: {
      name: 'Fillings',
      selectionType: 'multi',
      required: false,
      allowsHalves: false,
      options: PIZZA_TOPPINGS.map((name) => ({ name, priceCents: 100 })),
    },
    wing_sauce: {
      name: 'Sauce',
      selectionType: 'single',
      required: true,
      options: WING_SAUCES.map((name) => ({ name, priceCents: 0 })),
    },
    wing_dip: {
      name: 'Dip',
      selectionType: 'single',
      required: false,
      options: [
        { name: 'Blue Cheese', priceCents: 0 },
        { name: 'Ranch', priceCents: 0 },
      ],
    },
    sub_size: {
      name: 'Size',
      selectionType: 'single',
      required: true,
      options: [
        { name: 'Half', priceCents: 0 },
        { name: 'Whole', priceCents: 300 },
      ],
    },
    sub_extras: {
      name: 'Extras',
      selectionType: 'multi',
      required: false,
      options: [
        { name: 'Lettuce', priceCents: 0 },
        { name: 'Tomato', priceCents: 0 },
        { name: 'Onion', priceCents: 0 },
        { name: 'Mayo', priceCents: 0 },
        { name: 'Oil & Vinegar', priceCents: 0 },
        { name: 'Hot Peppers', priceCents: 0 },
        { name: 'Extra Cheese', priceCents: 100 },
      ],
    },
    burger_extras: {
      name: 'Extras',
      selectionType: 'multi',
      required: false,
      options: [
        { name: 'Lettuce', priceCents: 0 },
        { name: 'Tomato', priceCents: 0 },
        { name: 'Onion', priceCents: 0 },
        { name: 'Pickles', priceCents: 0 },
        { name: 'Bacon', priceCents: 150 },
        { name: 'Cheese', priceCents: 100 },
      ],
    },
    dressing: {
      name: 'Dressing',
      selectionType: 'single',
      required: true,
      options: ['Italian', 'Ranch', 'Blue Cheese', 'Caesar', 'Balsamic', 'Greek', 'Oil & Vinegar', 'No Dressing'].map(
        (name) => ({ name, priceCents: 0 }),
      ),
    },
    salad_protein: {
      name: 'Add Protein',
      selectionType: 'single',
      required: false,
      options: [
        { name: 'Grilled Chicken', priceCents: 400 },
        { name: 'Fried Chicken', priceCents: 400 },
      ],
    },
    pasta_type: {
      name: 'Pasta',
      selectionType: 'single',
      required: false,
      options: ['Spaghetti', 'Penne', 'Ziti', 'Linguine'].map((name) => ({ name, priceCents: 0 })),
    },
  },
  rules: [
    // Pizzas by size: the specific rule first, the general one last.
    { all: ['pizza', 'small'], none: ['calzone', 'stromboli'], groups: ['toppings_small'] },
    { all: ['pizza', 'personal'], none: ['calzone', 'stromboli'], groups: ['toppings_small'] },
    { all: ['pizza', 'medium'], none: ['calzone', 'stromboli'], groups: ['toppings_medium'] },
    { all: ['pizza', 'large'], none: ['calzone', 'stromboli'], groups: ['toppings_large'] },
    { all: ['pizza', 'sheet'], none: ['calzone', 'stromboli'], groups: ['toppings_large'] },
    { all: ['pizza'], none: ['calzone', 'stromboli'], groups: ['toppings_medium'] },
    { all: ['calzone'], groups: ['fillings'] },
    { all: ['stromboli'], groups: ['fillings'] },
    { all: ['wings'], groups: ['wing_sauce', 'wing_dip'] },
    { all: ['tenders'], groups: ['wing_dip'] },
    { all: ['sub'], groups: ['sub_size', 'sub_extras'] },
    { all: ['cheesesteak'], groups: ['sub_extras'] },
    { all: ['hero'], groups: ['sub_size', 'sub_extras'] },
    { all: ['grinder'], groups: ['sub_size', 'sub_extras'] },
    { all: ['hoagie'], groups: ['sub_size', 'sub_extras'] },
    { all: ['burger'], groups: ['burger_extras'] },
    { all: ['salad'], none: ['side'], groups: ['dressing', 'salad_protein'] },
    { all: ['side salad'], groups: ['dressing'] },
    { all: ['dinners'], none: ['parmigiana', 'parm', 'lasagna', 'ziti', 'alfredo'], groups: ['pasta_type'] },
  ],
};

const deliTemplate: MenuTemplate = {
  id: 'deli',
  name: 'Deli & sandwich shop',
  description:
    'Sandwiches, subs, wraps, salads, soups and sides, with bread, cheese, size and extras choices set up so the bot can take a full sandwich order.',
  categories: [
    {
      name: 'Sandwiches',
      items: [
        { name: 'Turkey Sandwich' },
        { name: 'Roast Beef Sandwich' },
        { name: 'Ham & Cheese Sandwich' },
        { name: 'BLT' },
        { name: 'Tuna Salad Sandwich' },
        { name: 'Chicken Salad Sandwich' },
        { name: 'Grilled Chicken Sandwich' },
      ],
    },
    {
      name: 'Subs',
      items: [{ name: 'Italian Sub' }, { name: 'Turkey Sub' }, { name: 'Roast Beef Sub' }, { name: 'Veggie Sub' }],
    },
    {
      name: 'Wraps',
      items: [{ name: 'Chicken Caesar Wrap' }, { name: 'Turkey Wrap' }, { name: 'Veggie Wrap' }, { name: 'Buffalo Chicken Wrap' }],
    },
    {
      name: 'Salads',
      items: [{ name: 'Garden Salad' }, { name: 'Caesar Salad' }, { name: 'Chef Salad' }, { name: 'Greek Salad' }],
    },
    {
      name: 'Soups',
      items: [{ name: 'Chicken Noodle Soup' }, { name: 'Tomato Soup' }, { name: 'Soup of the Day' }],
    },
    {
      name: 'Sides',
      items: [{ name: 'Potato Salad' }, { name: 'Macaroni Salad' }, { name: 'Coleslaw' }, { name: 'Chips' }, { name: 'Pickle' }],
    },
    {
      name: 'Drinks',
      items: [{ name: 'Fountain Soda' }, { name: 'Bottled Water' }, { name: 'Iced Tea' }],
    },
  ],
  groups: {
    bread: {
      name: 'Bread',
      selectionType: 'single',
      required: true,
      options: ['White', 'Wheat', 'Rye', 'Roll', 'Multigrain'].map((name) => ({ name, priceCents: 0 })),
    },
    cheese: {
      name: 'Cheese',
      selectionType: 'single',
      required: false,
      options: ['American', 'Provolone', 'Swiss', 'Cheddar', 'No Cheese'].map((name) => ({ name, priceCents: 0 })),
    },
    sandwich_extras: {
      name: 'Extras',
      selectionType: 'multi',
      required: false,
      options: [
        { name: 'Lettuce', priceCents: 0 },
        { name: 'Tomato', priceCents: 0 },
        { name: 'Onion', priceCents: 0 },
        { name: 'Pickles', priceCents: 0 },
        { name: 'Mayo', priceCents: 0 },
        { name: 'Mustard', priceCents: 0 },
        { name: 'Oil & Vinegar', priceCents: 0 },
        { name: 'Bacon', priceCents: 150 },
      ],
    },
    sub_size: {
      name: 'Size',
      selectionType: 'single',
      required: true,
      options: [
        { name: 'Half', priceCents: 0 },
        { name: 'Whole', priceCents: 300 },
      ],
    },
    wrap_type: {
      name: 'Wrap',
      selectionType: 'single',
      required: false,
      options: ['Plain', 'Wheat', 'Spinach', 'Tomato'].map((name) => ({ name, priceCents: 0 })),
    },
    dressing: {
      name: 'Dressing',
      selectionType: 'single',
      required: true,
      options: ['Italian', 'Ranch', 'Blue Cheese', 'Caesar', 'Balsamic', 'Oil & Vinegar', 'No Dressing'].map((name) => ({
        name,
        priceCents: 0,
      })),
    },
    soup_size: {
      name: 'Size',
      selectionType: 'single',
      required: true,
      options: [
        { name: 'Cup', priceCents: 0 },
        { name: 'Bowl', priceCents: 200 },
      ],
    },
  },
  rules: [
    { all: ['sandwiches'], groups: ['bread', 'cheese', 'sandwich_extras'] },
    { all: ['sandwich'], groups: ['bread', 'cheese', 'sandwich_extras'] },
    { all: ['blt'], groups: ['bread', 'sandwich_extras'] },
    { all: ['sub'], groups: ['sub_size', 'cheese', 'sandwich_extras'] },
    { all: ['wrap'], groups: ['wrap_type', 'sandwich_extras'] },
    { all: ['salad'], none: ['potato', 'macaroni', 'tuna', 'chicken salad', 'egg'], groups: ['dressing'] },
    { all: ['soup'], groups: ['soup_size'] },
  ],
};

export const MENU_TEMPLATES: readonly MenuTemplate[] = [pizzaTemplate, deliTemplate];

export function getMenuTemplate(id: string): MenuTemplate | undefined {
  return MENU_TEMPLATES.find((t) => t.id === id);
}

/**
 * Plural-blind: "sub" finds "Hot Subs" and "wings" finds "Buffalo Wing".
 * A crude trailing-s strip, applied to both sides so it only has to be
 * consistent, not correct.
 */
function stem(text: string): string {
  return text
    .split(' ')
    .map((w) => (w.length > 3 && !w.endsWith('ss') ? w.replace(/s$/, '') : w))
    .join(' ');
}

/** Whole-word containment on normalized, stemmed text. */
function hasWords(haystack: string, phrase: string): boolean {
  return ` ${haystack} `.includes(` ${stem(normalizeTerm(phrase))} `);
}

/**
 * The template groups an item should have, by its name and section. Rules
 * run in order; a group name attaches once, first rule wins. Returns the
 * specs with their library keys so the caller can say which was used.
 */
export function templateGroupsFor(
  template: MenuTemplate,
  item: { name: string; category: string },
): Array<{ key: string; spec: MenuTemplateGroupSpec }> {
  const subject = stem(normalizeTerm(`${item.name} ${item.category}`));
  const out: Array<{ key: string; spec: MenuTemplateGroupSpec }> = [];
  const names = new Set<string>();
  for (const rule of template.rules) {
    if (!rule.all.every((w) => hasWords(subject, w))) continue;
    if (rule.none?.some((w) => hasWords(subject, w))) continue;
    for (const key of rule.groups) {
      const spec = template.groups[key];
      if (!spec) throw new Error(`Template ${template.id} rule names unknown group "${key}"`);
      const n = normalizeTerm(spec.name);
      if (names.has(n)) continue;
      names.add(n);
      out.push({ key, spec });
    }
  }
  return out;
}

/**
 * Which template fits a menu, judged by how many of its items a template's
 * rules would give a group to. Ties and no hits at all mean no suggestion:
 * the importer then offers "none" and the owner picks.
 */
export function suggestMenuTemplate(
  categories: Array<{ name: string; items: Array<{ name: string }> }>,
): MenuTemplate | undefined {
  const items = categories.flatMap((c) => c.items.map((i) => ({ name: i.name, category: c.name })));
  if (!items.length) return undefined;
  const scored = MENU_TEMPLATES.map((t) => ({
    t,
    hits: items.filter((i) => templateGroupsFor(t, i).length > 0).length,
  })).sort((a, b) => b.hits - a.hits);
  const [best, next] = scored;
  if (!best || best.hits === 0) return undefined;
  if (next && next.hits === best.hits) return undefined;
  return best.t;
}
