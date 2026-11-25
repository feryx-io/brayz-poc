import { describe, expect, it } from 'vitest';
import { buildOrderSms, type PricedLine } from '../src/routes/orders.js';

const lines: PricedLine[] = [
  {
    menuItemId: 'pizza',
    name: 'Pizza',
    quantity: 2,
    unitPriceCents: 1500,
    viaUpsell: false,
    specialInstructions: 'No onions',
    modifiers: [
      { modifierId: 'pepperoni', name: 'Pepperoni', priceCents: 100, portion: 'left' },
      { modifierId: 'mushrooms', name: 'Mushrooms', priceCents: 100, portion: 'right' },
      { modifierId: 'cheese', name: 'Extra cheese', priceCents: 100, portion: 'whole' },
    ],
  },
];

describe('kitchen SMS tickets', () => {
  it.each(['pickup', 'delivery', 'changed'] as const)(
    'preserves the complete %s ticket',
    (kind) => {
      const body = buildOrderSms({
        orderCode: '12345',
        customerName: 'Sam',
        lines,
        notes: 'Pack utensils separately',
        totalCents: 3600,
        delivery: kind === 'delivery' ? { address: '12 Main St' } : undefined,
        changed: kind === 'changed' ? { wasCents: 3000, onPos: true, revision: 1 } : undefined,
      });
      for (const detail of [
        '2x Pizza',
        'Pepperoni (left half)',
        'Mushrooms (right half)',
        'Extra cheese',
        'No onions',
        'Pack utensils separately',
      ]) {
        expect(body).toContain(detail);
      }
      if (kind === 'delivery') expect(body).toContain('12 Main St');
      if (kind === 'changed') expect(body).toContain('Amend the ticket on the till');
    },
  );
});
