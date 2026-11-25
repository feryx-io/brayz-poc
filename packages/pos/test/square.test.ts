import { describe, expect, it } from 'vitest';
import {
  ManualTicketProvider,
  PosCapabilityError,
  PosPermanentError,
  PosTransientError,
  SquarePosProvider,
  isRetryable,
  type PosConnection,
  type PosOrder,
  type SquareFetch,
} from '../src/index.js';

const conn: PosConnection = {
  locationId: 'loc-1',
  externalLocationId: 'SQ-LOC-1',
  accessToken: 'tok',
  environment: 'sandbox',
};

const order: PosOrder = {
  orderId: '11111111-2222-3333-4444-555555555555',
  orderCode: 'A4F2',
  fulfillmentType: 'pickup',
  customerName: 'Gray',
  customerPhone: '+15185550100',
  lines: [
    {
      name: 'Large cheese pizza',
      quantity: 2,
      unitPriceCents: 1499,
      specialInstructions: 'well done',
    },
    { name: 'Garlic knots', quantity: 1, unitPriceCents: 599 },
  ],
  subtotalCents: 3597,
  discountCents: 0,
  totalCents: 3597,
};

/** Records the calls so a test can assert on the exact request body. */
function recordingFetch(
  responder: (
    url: string,
    init: { method: string; body?: string },
  ) => {
    ok: boolean;
    status: number;
    body: unknown;
  },
) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const impl: SquareFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const res = responder(url, init);
    return { ok: res.ok, status: res.status, json: async () => res.body };
  };
  return { impl, calls };
}

describe('SquarePosProvider — createOrder', () => {
  it('maps lines, money, and pickup details, and keys idempotency on the Brayz order', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { order: { id: 'SQ-ORDER-1', version: 1 } },
    }));
    const res = await new SquarePosProvider(impl).createOrder(conn, order);

    expect(res.externalOrderId).toBe('SQ-ORDER-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://connect.squareupsandbox.com/v2/orders');

    const body = calls[0].body as any;
    // Square dedupes on this, so a Brayz retry must not raise a second ticket.
    expect(body.idempotency_key).toBe(`brayz-order:${order.orderId}`);
    expect(body.order.location_id).toBe('SQ-LOC-1');
    expect(body.order.reference_id).toBe('A4F2');
    // Cents pass straight through — no float ever enters the conversion.
    expect(body.order.line_items).toEqual([
      {
        name: 'Large cheese pizza',
        quantity: '2',
        base_price_money: { amount: 1499, currency: 'USD' },
        note: 'well done',
      },
      { name: 'Garlic knots', quantity: '1', base_price_money: { amount: 599, currency: 'USD' } },
    ]);
    expect(body.order.fulfillments[0].type).toBe('PICKUP');
    expect(body.order.fulfillments[0].pickup_details.recipient).toEqual({
      display_name: 'Gray',
      phone_number: '+15185550100',
    });
    // No discount on this order, so Square is told about none.
    expect(body.order.discounts).toBeUndefined();
  });

  it('sends a loyalty reward as an order-scoped discount', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { order: { id: 'SQ-ORDER-2' } },
    }));
    await new SquarePosProvider(impl).createOrder(conn, {
      ...order,
      discountCents: 500,
      totalCents: 3097,
    });
    expect((calls[0].body as any).order.discounts).toEqual([
      {
        name: 'Brayz loyalty reward',
        amount_money: { amount: 500, currency: 'USD' },
        scope: 'ORDER',
      },
    ]);
  });

  it('routes a delivery order to delivery details', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { order: { id: 'SQ-ORDER-3' } },
    }));
    await new SquarePosProvider(impl).createOrder(conn, { ...order, fulfillmentType: 'delivery' });
    expect((calls[0].body as any).order.fulfillments[0].type).toBe('DELIVERY');
  });

  it('uses the production host only when the connection says production', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { order: { id: 'SQ-ORDER-4' } },
    }));
    await new SquarePosProvider(impl).createOrder({ ...conn, environment: 'production' }, order);
    expect(calls[0].url.startsWith('https://connect.squareup.com/')).toBe(true);
  });
});

describe('SquarePosProvider — error classification', () => {
  it('treats a 4xx as permanent so a bad request is not retried forever', async () => {
    const { impl } = recordingFetch(() => ({
      ok: false,
      status: 400,
      body: { errors: [{ detail: 'Invalid line item' }] },
    }));
    const err = await new SquarePosProvider(impl).createOrder(conn, order).catch((e) => e);
    expect(err).toBeInstanceOf(PosPermanentError);
    expect(err.message).toContain('Invalid line item');
    expect(isRetryable(err)).toBe(false);
  });

  it('treats 429 and 5xx as transient', async () => {
    for (const status of [429, 500, 503]) {
      const { impl } = recordingFetch(() => ({ ok: false, status, body: {} }));
      const err = await new SquarePosProvider(impl).createOrder(conn, order).catch((e) => e);
      expect(err, `status ${status}`).toBeInstanceOf(PosTransientError);
      expect(isRetryable(err)).toBe(true);
    }
  });

  it('treats a network failure as transient', async () => {
    const impl: SquareFetch = async () => {
      throw new Error('ECONNRESET');
    };
    const err = await new SquarePosProvider(impl).createOrder(conn, order).catch((e) => e);
    expect(err).toBeInstanceOf(PosTransientError);
    expect(isRetryable(err)).toBe(true);
  });

  it('refuses to push without a configured location or token', async () => {
    const { impl } = recordingFetch(() => ({ ok: true, status: 200, body: {} }));
    const p = new SquarePosProvider(impl);
    await expect(
      p.createOrder({ ...conn, externalLocationId: undefined }, order),
    ).rejects.toBeInstanceOf(PosPermanentError);
    await expect(p.createOrder({ ...conn, accessToken: undefined }, order)).rejects.toBeInstanceOf(
      PosPermanentError,
    );
  });
});

describe('SquarePosProvider — updateOrderStatus', () => {
  it('reads the current version before writing, as Square requires', async () => {
    const { impl, calls } = recordingFetch((url, init) =>
      init.method === 'GET'
        ? { ok: true, status: 200, body: { order: { id: 'SQ-1', version: 7 } } }
        : { ok: true, status: 200, body: { order: { id: 'SQ-1', version: 8 } } },
    );
    await new SquarePosProvider(impl).updateOrderStatus(conn, 'SQ-1', 'completed');

    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    expect((calls[1].body as any).order).toEqual({ version: 7, state: 'COMPLETED' });
  });

  it('maps canceled, and stays silent for states Square has no word for', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { order: { id: 'SQ-1', version: 2 } },
    }));
    const p = new SquarePosProvider(impl);

    await p.updateOrderStatus(conn, 'SQ-1', 'canceled');
    expect((calls[1].body as any).order.state).toBe('CANCELED');

    // 'accepted'/'ready' are already covered by the ticket being OPEN — writing
    // OPEN over OPEN would only burn a version.
    const before = calls.length;
    await p.updateOrderStatus(conn, 'SQ-1', 'accepted');
    await p.updateOrderStatus(conn, 'SQ-1', 'ready');
    expect(calls.length).toBe(before);
  });
});

describe('SquarePosProvider — getMenu', () => {
  it('reads catalog items and skips variable-price ones it cannot quote', async () => {
    const { impl } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: {
        objects: [
          {
            id: 'ITEM-1',
            item_data: {
              name: 'Margherita',
              description: 'Basil, mozzarella',
              variations: [{ item_variation_data: { price_money: { amount: 1299 } } }],
            },
          },
          // Priced at the register — nothing the bot could quote on a call.
          {
            id: 'ITEM-2',
            item_data: { name: 'Market fish', variations: [{ item_variation_data: {} }] },
          },
          { id: 'NOT-AN-ITEM' },
        ],
      },
    }));
    const items = await new SquarePosProvider(impl).getMenu(conn);
    expect(items).toEqual([
      {
        externalItemId: 'ITEM-1',
        name: 'Margherita',
        description: 'Basil, mozzarella',
        priceCents: 1299,
        available: true,
      },
    ]);
  });

  it('reports syncMenu as unsupported rather than pretending to write', async () => {
    const { impl } = recordingFetch(() => ({ ok: true, status: 200, body: {} }));
    const p = new SquarePosProvider(impl);
    expect(p.capabilities.syncMenu).toBe(false);
    await expect(p.syncMenu(conn, [])).rejects.toBeInstanceOf(PosCapabilityError);
  });
});

describe('ManualTicketProvider', () => {
  it('raises a ticket numbered by the code the guest was given', async () => {
    const res = await new ManualTicketProvider().createOrder(conn, order);
    expect(res.externalOrderId).toBe('manual:A4F2');
  });

  it('accepts status updates as a no-op and declines menu work', async () => {
    const p = new ManualTicketProvider();
    await expect(p.updateOrderStatus()).resolves.toBeUndefined();
    await expect(p.getMenu()).rejects.toBeInstanceOf(PosCapabilityError);
    // A capability error is permanent — retrying it would never succeed.
    expect(isRetryable(new PosCapabilityError('manual', 'getMenu'))).toBe(false);
  });
});
