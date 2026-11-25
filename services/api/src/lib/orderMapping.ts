import type { PosOrder } from '@brayz/pos';
import { DeliveryAddress, formatDeliveryAddress } from '@brayz/shared';

/**
 * The short code the guest is told on the call and the restaurant reads off the
 * ticket. Derived from the order id so it needs no separate sequence and stays
 * stable across retries.
 */
export function orderCode(id: string): string {
  return id.replace(/-/g, '').slice(-5).toUpperCase();
}

interface OrderRow {
  id: string;
  /** Optional because the create path defaults it in Postgres, not in the input. */
  fulfillmentType?: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  subtotalCents: number;
  /** Delivery orders: the fee inside `totalCents`, and the stored address snapshot (Json). */
  deliveryFeeCents?: number | null;
  deliveryAddress?: unknown;
  totalCents: number;
  items: Array<{
    name: string;
    quantity: number;
    unitPriceCents: number;
    specialInstructions: string | null;
    modifiers?: Array<{ name: string; priceCents: number }>;
  }>;
}

/**
 * A stored order as the POS adapters want it. Totals are passed through from
 * Postgres rather than recomputed — the order route already priced every line
 * from the menu (rule #5), and re-deriving here would let the two drift.
 */
export function toPosOrder(order: OrderRow, code: string, opts: { region?: string | null } = {}): PosOrder {
  const delivery = order.fulfillmentType === 'delivery';
  const fee = delivery ? (order.deliveryFeeCents ?? 0) : 0;
  const parsed = delivery ? DeliveryAddress.safeParse(order.deliveryAddress) : null;
  const address = parsed?.success ? parsed.data : null;
  return {
    orderId: order.id,
    orderCode: code,
    fulfillmentType: delivery ? 'delivery' : 'pickup',
    customerName: order.customerName ?? undefined,
    customerPhone: order.customerPhone ?? undefined,
    notes: order.notes ?? undefined,
    deliveryAddress: address
      ? { ...address, region: opts.region ?? undefined, formatted: formatDeliveryAddress(address) }
      : undefined,
    deliveryFeeCents: fee > 0 ? fee : undefined,
    lines: order.items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      specialInstructions: i.specialInstructions ?? undefined,
      modifiers: i.modifiers?.length
        ? i.modifiers.map((m) => ({ name: m.name, priceCents: m.priceCents }))
        : undefined,
    })),
    subtotalCents: order.subtotalCents,
    // Rewards and promotions are all that lies between subtotal-plus-fee and
    // total; the adapters need them as their own line so the POS shows the discount.
    discountCents: Math.max(0, order.subtotalCents + fee - order.totalCents),
    totalCents: order.totalCents,
  };
}
