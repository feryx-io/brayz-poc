/**
 * POS abstraction (CLAUDE.md rule #2). Square is the first implementation, not
 * the platform model — call/order logic talks to `PosProvider` and never to a
 * vendor SDK. A new POS is a new adapter in this package and nothing else.
 *
 * Brayz stays the system of record either way (rule #3): the order is committed
 * to Postgres first and only then pushed here, so a POS outage loses a ticket
 * from the till, never from Brayz.
 */

// The vendor list is a wire contract shared with the API and dashboard, so it
// lives in @brayz/shared and is re-exported here for adapters' convenience.
export type { PosProviderName } from '@brayz/shared';
import type { PosProviderName } from '@brayz/shared';

/** What an adapter can actually do. Callers check before offering the action. */
export interface PosCapabilities {
  /** Push a Brayz order to the POS as a ticket. */
  createOrder: boolean;
  /** Reflect a Brayz status change (ready, canceled) back to the POS. */
  updateOrderStatus: boolean;
  /** Read the POS catalog. */
  getMenu: boolean;
  /** Push the Brayz menu into the POS catalog. */
  syncMenu: boolean;
}

/** Per-location POS credentials/config, loaded from the location's integration. */
export interface PosConnection {
  locationId: string;
  /** Vendor-side location/merchant this Brayz location maps to. */
  externalLocationId?: string;
  accessToken?: string;
  /** Sandbox vs production, where the vendor separates them. */
  environment?: 'sandbox' | 'production';
}

/** An option chosen for a line (a crust, a topping), priced by Brayz. */
export interface PosOrderLineModifier {
  name: string;
  priceCents: number;
}

export interface PosOrderLine {
  name: string;
  quantity: number;
  unitPriceCents: number;
  specialInstructions?: string;
  /**
   * Options chosen for this line. A ticket that reads "Large Pizza" when the
   * caller asked for thin crust is a wrong ticket, so these ride as structured
   * lines rather than inside the note.
   */
  modifiers?: PosOrderLineModifier[];
  /** Vendor catalog id, when the item has been mapped. Ad-hoc line otherwise. */
  externalItemId?: string;
}

export interface PosOrder {
  /** Brayz order id — also the idempotency key on the vendor side. */
  orderId: string;
  /** Short human code the guest is told on the call ("A4F2"). */
  orderCode: string;
  fulfillmentType: 'pickup' | 'delivery';
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  /** Delivery orders: where it goes. */
  deliveryAddress?: PosDeliveryAddress;
  lines: PosOrderLine[];
  /** Authoritative totals, already computed by Brayz (rule #5). */
  subtotalCents: number;
  /** Delivery fee, already in `totalCents`; adapters show it as its own charge. */
  deliveryFeeCents?: number;
  discountCents: number;
  totalCents: number;
}

export interface PosDeliveryAddress {
  line1: string;
  line2?: string;
  city?: string;
  /** State / province, when known (the restaurant's own, for a local delivery). */
  region?: string;
  postalCode?: string;
  /** For the driver. */
  instructions?: string;
  /** The whole address on one line, for a POS with a single free-text field. */
  formatted: string;
}

export interface PosOrderResult {
  /** Vendor's id for the created ticket, stored for later status updates. */
  externalOrderId: string;
  /** Anything worth keeping for support, never used in business logic. */
  raw?: Record<string, unknown>;
}

/** Brayz order lifecycle, normalized. Adapters map these onto vendor states. */
export type PosOrderStatus = 'confirmed' | 'accepted' | 'ready' | 'completed' | 'canceled';

export interface PosMenuItem {
  externalItemId: string;
  name: string;
  description?: string;
  priceCents: number;
  available: boolean;
  categoryName?: string;
}

export interface PosProvider {
  readonly name: PosProviderName;
  readonly capabilities: PosCapabilities;
  /**
   * Push a confirmed order to the POS. Must be idempotent on `order.orderId`:
   * Brayz retries failed pushes, and a retry must not double the ticket.
   */
  createOrder(conn: PosConnection, order: PosOrder): Promise<PosOrderResult>;
  /** Reflect a Brayz status change onto an already-pushed ticket. */
  updateOrderStatus(
    conn: PosConnection,
    externalOrderId: string,
    status: PosOrderStatus,
  ): Promise<void>;
  /** Read the POS catalog, for importing a menu Brayz doesn't have yet. */
  getMenu(conn: PosConnection): Promise<PosMenuItem[]>;
  /** Push Brayz's menu into the POS catalog. */
  syncMenu(conn: PosConnection, items: PosMenuItem[]): Promise<void>;
}

/**
 * The adapter cannot do this — a permanent failure, unlike a network error.
 * Callers must not retry it; there is nothing to retry into.
 */
export class PosCapabilityError extends Error {
  readonly code = 'pos_capability_unsupported';
  constructor(provider: string, capability: keyof PosCapabilities) {
    super(`${provider} does not support ${capability}`);
    this.name = 'PosCapabilityError';
  }
}

/** The vendor rejected the request and retrying it unchanged will not help. */
export class PosPermanentError extends Error {
  readonly code = 'pos_permanent_error';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PosPermanentError';
  }
}

/** The vendor was unreachable or failed transiently — worth retrying. */
export class PosTransientError extends Error {
  readonly code = 'pos_transient_error';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PosTransientError';
  }
}

/**
 * Is this failure worth another attempt? Anything that isn't explicitly
 * permanent is treated as transient — a bug in our classification should cost a
 * retry, not a lost ticket.
 */
export function isRetryable(err: unknown): boolean {
  return !(err instanceof PosPermanentError || err instanceof PosCapabilityError);
}

export { ManualTicketProvider } from './manual.js';
export { SquarePosProvider } from './square.js';
export type { SquareFetch } from './square.js';
