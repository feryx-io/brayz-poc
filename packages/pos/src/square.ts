import {
  PosCapabilityError,
  PosPermanentError,
  PosTransientError,
  type PosCapabilities,
  type PosConnection,
  type PosMenuItem,
  type PosOrder,
  type PosOrderResult,
  type PosOrderStatus,
  type PosProvider,
  type PosProviderName,
} from './index.js';

/** Injectable so tests drive the adapter without a network. */
export type SquareFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Pinned: Square dates its API, and an unpinned version changes under us. */
const SQUARE_VERSION = '2025-01-23';
/** MVP is US pickup only; multi-currency arrives with international locations. */
const CURRENCY = 'USD';

/**
 * Square Orders + Catalog adapter.
 *
 * Money is already in cents on both sides, so amounts pass through untouched —
 * no float ever enters the conversion. Prices come from the Brayz order, which
 * re-priced every line from the menu (rule #5); Square is told what to charge,
 * it is never asked.
 */
export class SquarePosProvider implements PosProvider {
  readonly name: PosProviderName = 'square';
  readonly capabilities: PosCapabilities = {
    createOrder: true,
    updateOrderStatus: true,
    getMenu: true,
    // Catalog writes need object versioning and image/modifier mapping — a
    // separate piece of work, so Brayz→Square stays one-way for now.
    syncMenu: false,
  };

  constructor(private readonly fetchImpl: SquareFetch = defaultFetch) {}

  async createOrder(conn: PosConnection, order: PosOrder): Promise<PosOrderResult> {
    if (!conn.externalLocationId) {
      throw new PosPermanentError('Square integration has no location id configured');
    }
    const body = {
      // Square dedupes on this key, so a Brayz retry re-reads the ticket it
      // already created instead of raising a second one (rule #7).
      idempotency_key: `brayz-order:${order.orderId}`,
      order: {
        location_id: conn.externalLocationId,
        reference_id: order.orderCode,
        line_items: order.lines.map((line) => ({
          name: line.name,
          quantity: String(line.quantity),
          base_price_money: { amount: line.unitPriceCents, currency: CURRENCY },
          // Ad-hoc modifiers: Square prices them on top of the line's base
          // price, which is exactly how Brayz priced them.
          ...(line.modifiers?.length
            ? {
                modifiers: line.modifiers.map((m) => ({
                  name: m.name,
                  base_price_money: { amount: m.priceCents, currency: CURRENCY },
                })),
              }
            : {}),
          ...(line.specialInstructions ? { note: line.specialInstructions } : {}),
          ...(line.externalItemId ? { catalog_object_id: line.externalItemId } : {}),
        })),
        ...(order.discountCents > 0
          ? {
              discounts: [
                {
                  name: 'Brayz loyalty reward',
                  amount_money: { amount: order.discountCents, currency: CURRENCY },
                  scope: 'ORDER',
                },
              ],
            }
          : {}),
        // The delivery fee is already in Brayz's total; as a service charge the
        // ticket shows it and Square's total agrees with the one the caller heard.
        ...(order.deliveryFeeCents && order.deliveryFeeCents > 0
          ? {
              service_charges: [
                {
                  name: 'Delivery fee',
                  amount_money: { amount: order.deliveryFeeCents, currency: CURRENCY },
                  calculation_phase: 'TOTAL_PHASE',
                },
              ],
            }
          : {}),
        fulfillments: [buildFulfillment(order)],
        ...(order.notes ? { note: order.notes } : {}),
      },
    };

    const res = await this.call(conn, 'POST', '/v2/orders', body);
    const orderId = (res as { order?: { id?: string } }).order?.id;
    if (!orderId) throw new PosPermanentError('Square accepted the order but returned no id');
    return { externalOrderId: orderId, raw: res as Record<string, unknown> };
  }

  async updateOrderStatus(
    conn: PosConnection,
    externalOrderId: string,
    status: PosOrderStatus,
  ): Promise<void> {
    const state = squareState(status);
    // Only terminal transitions are meaningful to Square: an order sitting in
    // OPEN already reflects "confirmed"/"accepted"/"ready", and writing OPEN
    // over OPEN just burns a version.
    if (!state) return;

    // Square rejects a stale version, which is how it prevents lost updates —
    // so read the current one rather than remembering it across a retry.
    const current = await this.call(conn, 'GET', `/v2/orders/${externalOrderId}`);
    const version = (current as { order?: { version?: number } }).order?.version;
    if (version === undefined) {
      throw new PosPermanentError(`Square order ${externalOrderId} has no version`);
    }

    await this.call(conn, 'PUT', `/v2/orders/${externalOrderId}`, {
      idempotency_key: `brayz-status:${externalOrderId}:${status}`,
      order: { version, state },
    });
  }

  async getMenu(conn: PosConnection): Promise<PosMenuItem[]> {
    const res = await this.call(conn, 'GET', '/v2/catalog/list?types=ITEM');
    const objects = (res as { objects?: SquareCatalogObject[] }).objects ?? [];
    const items: PosMenuItem[] = [];
    for (const obj of objects) {
      const data = obj.item_data;
      if (!data) continue;
      // A Square item prices itself through variations; the first is the base.
      const variation = data.variations?.[0]?.item_variation_data;
      const amount = variation?.price_money?.amount;
      if (amount === undefined) continue; // variable-price item — nothing to quote on a call
      items.push({
        externalItemId: obj.id,
        name: data.name ?? 'Unnamed item',
        description: data.description ?? undefined,
        priceCents: amount,
        available: obj.is_deleted !== true,
      });
    }
    return items;
  }

  async syncMenu(): Promise<void> {
    throw new PosCapabilityError(this.name, 'syncMenu');
  }

  private async call(
    conn: PosConnection,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!conn.accessToken) throw new PosPermanentError('Square integration has no access token');
    const base =
      conn.environment === 'production'
        ? 'https://connect.squareup.com'
        : 'https://connect.squareupsandbox.com';

    let res: Awaited<ReturnType<SquareFetch>>;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${conn.accessToken}`,
          'square-version': SQUARE_VERSION,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      // Never reached Square — always worth another attempt.
      throw new PosTransientError(`Square request failed: ${String(err)}`);
    }

    const payload = await res.json().catch(() => undefined);
    if (res.ok) return payload;

    const detail = squareErrorDetail(payload) ?? `HTTP ${res.status}`;
    // 429 and 5xx clear on their own; every other 4xx is our request being
    // wrong, and replaying it unchanged would fail the same way forever.
    if (res.status === 429 || res.status >= 500) {
      throw new PosTransientError(`Square: ${detail}`, res.status);
    }
    throw new PosPermanentError(`Square: ${detail}`, res.status);
  }
}

/** Brayz status → Square order state. `null` means "nothing to tell Square". */
function squareState(status: PosOrderStatus): 'COMPLETED' | 'CANCELED' | null {
  switch (status) {
    case 'completed':
      return 'COMPLETED';
    case 'canceled':
      return 'CANCELED';
    default:
      return null;
  }
}

function buildFulfillment(order: PosOrder) {
  const recipient = {
    ...(order.customerName ? { display_name: order.customerName } : {}),
    ...(order.customerPhone ? { phone_number: order.customerPhone } : {}),
  };
  if (order.fulfillmentType === 'delivery') {
    const a = order.deliveryAddress;
    return {
      type: 'DELIVERY',
      state: 'PROPOSED',
      delivery_details: {
        recipient: a
          ? {
              ...recipient,
              address: {
                address_line_1: a.line1,
                ...(a.line2 ? { address_line_2: a.line2 } : {}),
                ...(a.city ? { locality: a.city } : {}),
                ...(a.region ? { administrative_district_level_1: a.region } : {}),
                ...(a.postalCode ? { postal_code: a.postalCode } : {}),
                country: 'US',
              },
            }
          : recipient,
        schedule_type: 'ASAP',
        ...(a?.instructions ? { note: a.instructions } : {}),
      },
    };
  }
  return {
    type: 'PICKUP',
    state: 'PROPOSED',
    pickup_details: { recipient, schedule_type: 'ASAP' },
  };
}

/** Square reports failures as `{ errors: [{ detail, code }] }`. */
function squareErrorDetail(payload: unknown): string | undefined {
  const errors = (payload as { errors?: Array<{ detail?: string; code?: string }> } | undefined)
    ?.errors;
  if (!errors?.length) return undefined;
  return (
    errors
      .map((e) => e.detail ?? e.code)
      .filter(Boolean)
      .join('; ') || undefined
  );
}

interface SquareCatalogObject {
  id: string;
  is_deleted?: boolean;
  item_data?: {
    name?: string;
    description?: string;
    variations?: Array<{ item_variation_data?: { price_money?: { amount?: number } } }>;
  };
}

const defaultFetch: SquareFetch = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<SquareFetch>;
