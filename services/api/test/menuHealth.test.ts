import { describe, expect, it } from 'vitest';
import { analyzeMenu, type MenuSnapshot, type SnapshotItem } from '../src/lib/menuHealth.js';

/**
 * The checks, against a menu shaped like the one the real calls were made
 * on: build-your-own pizzas with a toppings group, a calzone whose text
 * promises toppings it has no group for, wings with a sauce group, and the
 * asks callers actually made.
 */
const NOW = new Date('2026-09-04T18:00:00Z');
const ago = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const toppings = (id: string, allowsHalves = true) => ({
  id: `${id}-top`,
  name: 'Toppings',
  selectionType: 'multi',
  required: false,
  allowsHalves,
  modifiers: [
    { id: `${id}-pep`, name: 'Pepperoni', priceCents: 150, available: true },
    { id: `${id}-saus`, name: 'Sausage', priceCents: 150, available: true },
    { id: `${id}-chix`, name: 'Chicken', priceCents: 300, available: true },
  ],
});

function menu(overrides: Partial<Record<string, Partial<SnapshotItem>>> = {}): SnapshotItem[] {
  const base: SnapshotItem[] = [
    {
      id: 'large',
      name: 'Large Pizza (18")',
      category: 'Pizza',
      description: null,
      priceCents: 1900,
      available: true,
      groups: [toppings('large')],
    },
    {
      id: 'calzone',
      name: 'Calzone',
      category: 'Calzone & Stromboli',
      description: 'Ricotta & mozzarella with pizza toppings of your choice - toppings $1 each',
      priceCents: 1150,
      available: true,
      groups: [],
    },
    {
      id: 'wings',
      name: 'Boneless Wings',
      category: 'Starters',
      description: null,
      priceCents: 1200,
      available: true,
      groups: [
        {
          id: 'wings-sauce',
          name: 'Sauce',
          selectionType: 'single',
          required: true,
          allowsHalves: false,
          modifiers: [{ id: 'w-mild', name: 'Mild', priceCents: 0, available: true }],
        },
      ],
    },
    {
      id: 'knots',
      name: 'Garlic Knots',
      category: 'Starters',
      description: null,
      priceCents: 599,
      available: true,
      groups: [],
    },
  ];
  return base.map((i) => ({ ...i, ...(overrides[i.id] ?? {}) }));
}

const snap = (items: SnapshotItem[], extra: Partial<MenuSnapshot> = {}): MenuSnapshot => ({
  items,
  gaps: [],
  instructions: [],
  ...extra,
});

const byCode = (findings: ReturnType<typeof analyzeMenu>, code: string) => findings.filter((f) => f.code === code);

describe('menu health', () => {
  it('flags a description that promises choices with no group, and copies the sibling group at the named price', () => {
    const f = byCode(analyzeMenu(snap(menu()), NOW), 'options_promised_no_group');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: 'fix', itemId: 'calzone', title: 'Calzone promises choices it cannot take' });
    expect(f[0]!.fix).toEqual({
      kind: 'create_group',
      itemId: 'calzone',
      name: 'Toppings',
      selectionType: 'multi',
      required: false,
      // "$1 each" in the description wins over the pizza's own prices.
      modifiers: [
        { name: 'Pepperoni', priceCents: 100 },
        { name: 'Sausage', priceCents: 100 },
        { name: 'Chicken', priceCents: 100 },
      ],
    });
  });

  it('keeps the donor prices when the description names none', () => {
    const items = menu({ calzone: { description: 'Stuffed with your choice of toppings' } });
    const [f] = byCode(analyzeMenu(snap(items), NOW), 'options_promised_no_group');
    expect(f?.fix?.kind).toBe('create_group');
    expect(f?.fix && 'modifiers' in f.fix ? f.fix.modifiers[0] : null).toEqual({ name: 'Pepperoni', priceCents: 150 });
  });

  it('copies a pizza’s toppings onto a pizza in another section, not the calzone’s', () => {
    const items = [
      ...menu({ calzone: { groups: [{ ...toppings('calzone', false), modifiers: [{ id: 'c-pep', name: 'Pepperoni', priceCents: 100, available: true }] }], description: null } }),
      {
        id: 'gcb',
        name: 'Garlic Cheesy Bread Pizza (Large)',
        category: 'Specialty Pizza',
        description: 'Garlic butter base, then topped with red sauce, add any toppings',
        priceCents: 2175,
        available: true,
        groups: [],
      },
    ];
    const [f] = byCode(analyzeMenu(snap(items), NOW), 'options_promised_no_group');
    expect(f?.itemId).toBe('gcb');
    expect(f?.detail).toContain('Large Pizza (18") has a Toppings group');
    expect(f?.fix && 'modifiers' in f.fix ? f.fix.modifiers[0] : null).toEqual({ name: 'Pepperoni', priceCents: 150 });
  });

  it('is quiet about an item with no description, or with a group already', () => {
    const items = menu({ calzone: { groups: [toppings('calzone', false)] } });
    expect(byCode(analyzeMenu(snap(items), NOW), 'options_promised_no_group')).toHaveLength(0);
    // Garlic Knots say nothing, so nothing is promised.
    expect(analyzeMenu(snap(menu()), NOW).some((f) => f.itemId === 'knots')).toBe(false);
  });

  it('turns option asks into an add to the item’s own group, priced like the sibling', () => {
    const items = menu();
    const findings = analyzeMenu(
      snap(items, {
        gaps: [
          { kind: 'option', term: 'bbq', rawTerm: 'BBQ', onItem: 'Boneless Wings', createdAt: ago(2) },
          { kind: 'option', term: 'bbq', rawTerm: 'barbecue', onItem: 'Boneless Wings', createdAt: ago(9) },
          { kind: 'item', term: 'ketchup', rawTerm: 'Ketchup', onItem: null, createdAt: ago(1) },
        ],
      }),
      NOW,
    );
    // Nothing on the menu offers BBQ: a warning with the count, no fix.
    const [bbq] = byCode(findings, 'option_asked_not_offered');
    expect(bbq).toMatchObject({ severity: 'warn', itemId: 'wings', evidence: { count: 2 } });
    expect(bbq?.title).toBe('Callers ask for BBQ on Boneless Wings');
    expect(bbq?.detail).toContain('2 times');
    expect(bbq?.detail).toContain('2 days ago');
    expect(bbq?.fix).toBeUndefined();
    // Item gaps belong to the gaps card, not here.
    expect(findings.some((f) => /ketchup/i.test(f.title))).toBe(false);
  });

  it('offers a fix when a sibling item already has the option', () => {
    const items = menu();
    const findings = analyzeMenu(
      snap(items, {
        gaps: [{ kind: 'option', term: 'chicken', rawTerm: 'chicken', onItem: 'Garlic Knots', createdAt: ago(1) }],
      }),
      NOW,
    );
    const [f] = byCode(findings, 'option_asked_not_offered');
    // Knots have no group, so the fix makes one named like the donor's.
    expect(f?.fix).toEqual({
      kind: 'create_group',
      itemId: 'knots',
      name: 'Toppings',
      selectionType: 'multi',
      required: false,
      modifiers: [{ name: 'Chicken', priceCents: 300 }],
    });
  });

  it('reads the same ask out of free text on ordered lines', () => {
    const items = menu({ calzone: { description: null, groups: [{ ...toppings('calzone', false), modifiers: [] }] } });
    const findings = analyzeMenu(
      snap(items, {
        instructions: [
          { menuItemId: 'calzone', itemName: 'Calzone', text: 'Sausage; Pepperoni', createdAt: ago(0) },
          { menuItemId: 'calzone', itemName: 'Calzone', text: 'extra sausage please', createdAt: ago(3) },
        ],
      }),
      NOW,
    );
    const asks = byCode(findings, 'option_asked_not_offered');
    const sausage = asks.find((f) => /Sausage/.test(f.title));
    expect(sausage).toMatchObject({ severity: 'fix', evidence: { count: 2 } });
    // The calzone has an (empty) Toppings group, so the fix adds to it.
    expect(sausage?.fix).toEqual({ kind: 'add_modifier', groupId: 'calzone-top', name: 'Sausage', priceCents: 150 });
    expect(asks.find((f) => /Pepperoni/.test(f.title))?.evidence.count).toBe(1);
  });

  it('does not take "garlic" out of "garlic parm" on wings that offer Garlic Parmesan', () => {
    const wingsWithGp = menu({
      wings: {
        groups: [
          {
            ...menu()[2]!.groups[0]!,
            modifiers: [{ id: 'w-gp', name: 'Garlic Parmesan', priceCents: 0, available: true }],
          },
        ],
      },
      // The calzone offers a Garlic topping, which is where the false match came from.
      calzone: { description: null, groups: [{ ...toppings('calzone', false), modifiers: [{ id: 'c-garlic', name: 'Garlic', priceCents: 100, available: true }] }] },
    });
    const findings = analyzeMenu(
      snap(wingsWithGp, {
        instructions: [
          { menuItemId: 'wings', itemName: 'Boneless Wings', text: 'garlic parm', createdAt: ago(1) },
          { menuItemId: 'wings', itemName: 'Boneless Wings', text: 'Sauce changed from Garlic Parmesan to BBQ', createdAt: ago(1) },
          // A word inside another word is not a match either.
          { menuItemId: 'wings', itemName: 'Boneless Wings', text: 'garlicky please', createdAt: ago(1) },
        ],
      }),
      NOW,
    );
    expect(byCode(findings, 'option_asked_not_offered')).toHaveLength(0);
  });

  it('folds asks into the missing-group finding for the same item rather than competing with it', () => {
    const findings = analyzeMenu(
      snap(menu(), {
        instructions: [{ menuItemId: 'calzone', itemName: 'Calzone', text: 'chicken', createdAt: ago(2) }],
        gaps: [{ kind: 'option', term: 'sausage', rawTerm: 'sausage', onItem: 'Calzone', createdAt: ago(1) }],
      }),
      NOW,
    );
    expect(byCode(findings, 'option_asked_not_offered')).toHaveLength(0);
    const [f] = byCode(findings, 'options_promised_no_group');
    expect(f?.evidence).toMatchObject({ count: 2 });
    expect(f?.detail).toMatch(/Callers have asked for (sausage, Chicken|Chicken, sausage) on it 2 times/);
  });

  it('warns without a fix when the promised choices are not toppings, and reads "up to N"', () => {
    const items = menu({
      calzone: { description: 'Choose up to 2 toppings' },
      knots: { description: 'Choose cheese + sauce + add onion & green pepper' },
    });
    const findings = byCode(analyzeMenu(snap(items), NOW), 'options_promised_no_group');
    const calzone = findings.find((f) => f.itemId === 'calzone')!;
    expect(calzone.severity).toBe('fix');
    expect(calzone.fix).toMatchObject({ kind: 'create_group', maxSelections: 2 });
    expect(calzone.detail).toContain('up to 2 per order');
    const knots = findings.find((f) => f.itemId === 'knots')!;
    expect(knots.severity).toBe('warn');
    expect(knots.fix).toBeUndefined();
    expect(knots.detail).toContain('Add a group for those choices');
  });

  it('does not report an ask the menu has since answered', () => {
    const items = menu({ wings: { groups: [{ ...menu()[2]!.groups[0]!, modifiers: [{ id: 'w-bbq', name: 'BBQ', priceCents: 0, available: true }] }] } });
    const findings = analyzeMenu(
      snap(items, { gaps: [{ kind: 'option', term: 'bbq', rawTerm: 'BBQ', onItem: 'Boneless Wings', createdAt: ago(1) }] }),
      NOW,
    );
    expect(byCode(findings, 'option_asked_not_offered')).toHaveLength(0);
  });

  it('flags two items with one name', () => {
    const items = [...menu(), { ...menu()[1]!, id: 'calzone-2', category: 'Calzone', priceCents: 1350, description: null }];
    const [f] = byCode(analyzeMenu(snap(items), NOW), 'duplicate_item');
    expect(f?.title).toBe('"Calzone" appears 2 times');
    expect(f?.detail).toContain('Calzone at $13.50, no options');
    expect(f?.fix).toBeUndefined();
  });

  it('flags a pizza whose toppings cannot be split, with the switch as the fix', () => {
    const items = menu({ large: { groups: [toppings('large', false)] } });
    const [f] = byCode(analyzeMenu(snap(items), NOW), 'pizza_halves_off');
    expect(f).toMatchObject({ severity: 'fix', groupId: 'large-top', fix: { kind: 'allow_halves', groupId: 'large-top' } });
    // The calzone's toppings are meant to stay whole.
    const withCalzone = menu({ calzone: { groups: [toppings('calzone', false)] } });
    expect(byCode(analyzeMenu(snap(withCalzone), NOW), 'pizza_halves_off')).toHaveLength(0);
  });

  it('flags an empty group, harder when it is required', () => {
    const items = menu({ wings: { groups: [{ ...menu()[2]!.groups[0]!, modifiers: [] }] } });
    const [f] = byCode(analyzeMenu(snap(items), NOW), 'group_without_options');
    expect(f).toMatchObject({ severity: 'fix', groupId: 'wings-sauce' });
    expect(f?.detail).toContain('required');
  });

  it('flags a free item and sorts fixes before checks', () => {
    const items = menu({ knots: { priceCents: 0 } });
    const findings = analyzeMenu(snap(items), NOW);
    expect(byCode(findings, 'item_zero_price')[0]?.itemName).toBe('Garlic Knots');
    const sev = findings.map((f) => f.severity);
    expect(sev.indexOf('warn')).toBeGreaterThan(sev.lastIndexOf('fix'));
  });

  it('is quiet on a healthy menu', () => {
    const items = menu({ calzone: { groups: [toppings('calzone', false)] } });
    expect(analyzeMenu(snap(items), NOW)).toEqual([]);
  });
});
