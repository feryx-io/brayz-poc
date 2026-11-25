import { describe, expect, it } from 'vitest';
import { MENU_TEMPLATES, getMenuTemplate, suggestMenuTemplate, templateGroupsFor } from '../src/menuTemplates.js';

const pizzeria = getMenuTemplate('pizzeria')!;
const deli = getMenuTemplate('deli')!;

describe('menu templates', () => {
  it('every rule names a group that exists, and every starter item is unpriced', () => {
    for (const t of MENU_TEMPLATES) {
      for (const r of t.rules) for (const g of r.groups) expect(t.groups[g], `${t.id}:${g}`).toBeDefined();
      for (const c of t.categories) for (const i of c.items) expect(i).not.toHaveProperty('priceCents');
    }
  });

  it('gives a pizza its size-priced toppings, with halves left to the item rule', () => {
    const small = templateGroupsFor(pizzeria, { name: 'Small Cheese Pizza', category: 'Pizza' });
    const large = templateGroupsFor(pizzeria, { name: 'Cheese Pizza', category: 'Large Pizzas' });
    const plain = templateGroupsFor(pizzeria, { name: 'Margherita Pizza', category: 'Specialty Pizza' });
    expect(small.map((g) => g.key)).toEqual(['toppings_small']);
    expect(large.map((g) => g.key)).toEqual(['toppings_large']);
    expect(plain.map((g) => g.key)).toEqual(['toppings_medium']);
    expect(small[0]!.spec.allowsHalves).toBeUndefined();
    expect(small[0]!.spec.options[0]!.priceCents).toBeLessThan(large[0]!.spec.options[0]!.priceCents);
  });

  it('a calzone under the pizza section gets fillings with halves off, never toppings', () => {
    const got = templateGroupsFor(pizzeria, { name: 'Cheese Calzone', category: 'Pizza' });
    expect(got.map((g) => g.key)).toEqual(['fillings']);
    expect(got[0]!.spec.allowsHalves).toBe(false);
  });

  it('wings get a required sauce and an optional dip; a sub gets size and extras', () => {
    const wings = templateGroupsFor(pizzeria, { name: 'Boneless Wings', category: 'Appetizers' });
    expect(wings.map((g) => g.spec.name)).toEqual(['Sauce', 'Dip']);
    expect(wings[0]!.spec.required).toBe(true);
    const sub = templateGroupsFor(pizzeria, { name: 'Meatball Parm', category: 'Hot Subs' });
    expect(sub.map((g) => g.spec.name)).toEqual(['Size', 'Extras']);
  });

  it('matches whole words only, so "Subway Cookie" is not a sub and a dessert gets nothing', () => {
    expect(templateGroupsFor(pizzeria, { name: 'Subway Cookie', category: 'Desserts' })).toEqual([]);
    expect(templateGroupsFor(pizzeria, { name: 'Cannoli', category: 'Desserts' })).toEqual([]);
  });

  it('a side salad gets dressing but not the protein upsell', () => {
    expect(templateGroupsFor(pizzeria, { name: 'Side Salad', category: 'Sides' }).map((g) => g.key)).toEqual(['dressing']);
    expect(templateGroupsFor(pizzeria, { name: 'Greek Salad', category: 'Salads' }).map((g) => g.key)).toEqual([
      'dressing',
      'salad_protein',
    ]);
  });

  it('never attaches two groups of the same name to one item', () => {
    for (const t of MENU_TEMPLATES) {
      for (const c of t.categories) {
        for (const i of c.items) {
          const names = templateGroupsFor(t, { name: i.name, category: c.name }).map((g) => g.spec.name);
          expect(new Set(names).size).toBe(names.length);
        }
      }
    }
  });

  it('suggests the pizzeria for a pizza menu, the deli for a sandwich menu, nothing for a bakery', () => {
    expect(
      suggestMenuTemplate([{ name: 'Pizza', items: [{ name: 'Large Cheese Pizza' }, { name: 'Calzone' }] }])?.id,
    ).toBe('pizzeria');
    expect(
      suggestMenuTemplate([
        { name: 'Sandwiches', items: [{ name: 'Turkey Sandwich' }, { name: 'BLT' }] },
        { name: 'Soups', items: [{ name: 'Tomato Soup' }] },
      ])?.id,
    ).toBe('deli');
    expect(suggestMenuTemplate([{ name: 'Pastries', items: [{ name: 'Croissant' }] }])).toBeUndefined();
    expect(deli.rules.length).toBeGreaterThan(0);
  });
});
