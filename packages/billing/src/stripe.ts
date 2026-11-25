import crypto from 'node:crypto';
import type { BillingPlan, SubscriptionStatus } from '@brayz/shared';
import {
  BillingConfigError,
  BillingProviderError,
  type BillingProvider,
  type CheckoutRequest,
  type CheckoutSession,
  type PortalRequest,
  type SubscriptionSnapshot,
} from './index.js';

/** Injectable so tests drive the adapter without a network. */
export type StripeFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface StripeConfig {
  secretKey: string;
  /** Stripe price id per plan — the price of record lives in Stripe, not here. */
  priceIds: Partial<Record<BillingPlan, string>>;
  apiBase?: string;
}

/** Pinned: Stripe dates its API and an unpinned version changes under us. */
const STRIPE_VERSION = '2025-01-27.acacia';

/**
 * Stripe adapter. Hosted Checkout and the Billing Portal do the work, so Brayz
 * never sees a card number and never renders a payment form — the smallest
 * possible surface for the most sensitive thing in the product.
 *
 * Talks to Stripe's REST API directly rather than through the SDK: the calls
 * are form-encoded POSTs, and an injected fetch makes the whole adapter
 * testable without a network or a stubbed SDK.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  private readonly base: string;

  constructor(
    private readonly cfg: StripeConfig,
    private readonly fetchImpl: StripeFetch = defaultFetch,
  ) {
    this.base = cfg.apiBase ?? 'https://api.stripe.com';
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    const price = this.cfg.priceIds[req.plan];
    if (!price) throw new BillingConfigError(`No Stripe price configured for the ${req.plan} plan`);

    const form: Record<string, string> = {
      mode: 'subscription',
      'line_items[0][price]': price,
      'line_items[0][quantity]': '1',
      success_url: `${req.returnUrl}?checkout=success`,
      cancel_url: `${req.returnUrl}?checkout=cancelled`,
      // Carried back on the webhook so we can attach the subscription to the
      // right location without trusting a URL the browser came back on.
      'subscription_data[metadata][locationId]': req.locationId,
      'subscription_data[metadata][tenantId]': req.tenantId,
      'metadata[locationId]': req.locationId,
      'metadata[tenantId]': req.tenantId,
    };
    // Reuse the customer once Stripe has one, so a location's invoices, cards
    // and history stay on a single record across plan changes.
    if (req.customerId) form.customer = req.customerId;
    else if (req.customerEmail) form.customer_email = req.customerEmail;
    // Subscribing during the free trial starts billing when the trial ends,
    // not today. Stripe refuses a trial_end under 48 hours out, so a trial that
    // is all but over simply starts billing now.
    if (req.trialEndsAt && req.trialEndsAt.getTime() - Date.now() >= 48 * 60 * 60 * 1000) {
      form['subscription_data[trial_end]'] = String(Math.floor(req.trialEndsAt.getTime() / 1000));
    }

    const res = (await this.call('POST', '/v1/checkout/sessions', form)) as {
      id?: string;
      url?: string;
    };
    if (!res.url || !res.id) throw new BillingProviderError('Stripe returned no checkout URL');
    return { url: res.url, sessionId: res.id };
  }

  async createPortal(req: PortalRequest): Promise<{ url: string }> {
    const res = (await this.call('POST', '/v1/billing_portal/sessions', {
      customer: req.customerId,
      return_url: req.returnUrl,
    })) as { url?: string };
    if (!res.url) throw new BillingProviderError('Stripe returned no portal URL');
    return { url: res.url };
  }

  async getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null> {
    const res = (await this.call(
      'GET',
      `/v1/subscriptions/${subscriptionId}`,
    )) as StripeSubscription;
    if (!res?.id) return null;
    return snapshotFromSubscription(res, this.cfg.priceIds);
  }

  private async call(
    method: string,
    path: string,
    form?: Record<string, string>,
  ): Promise<unknown> {
    if (!this.cfg.secretKey) throw new BillingConfigError('Stripe is not configured');
    let res: Awaited<ReturnType<StripeFetch>>;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.secretKey}`,
          'stripe-version': STRIPE_VERSION,
          'content-type': 'application/x-www-form-urlencoded',
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
    } catch (err) {
      throw new BillingProviderError(`Stripe request failed: ${String(err)}`);
    }

    const payload = await res.json().catch(() => undefined);
    if (res.ok) return payload;
    const message =
      (payload as { error?: { message?: string } } | undefined)?.error?.message ??
      `HTTP ${res.status}`;
    throw new BillingProviderError(`Stripe: ${message}`, res.status);
  }
}

interface StripeSubscription {
  id?: string;
  customer?: string | { id?: string };
  status?: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  items?: { data?: Array<{ price?: { id?: string } }> };
  metadata?: Record<string, string>;
}

/** Which plan a Stripe price id belongs to, or null if we don't sell it. */
export function planFromPriceId(
  priceId: string | undefined,
  priceIds: Partial<Record<BillingPlan, string>>,
): BillingPlan | null {
  if (!priceId) return null;
  for (const [plan, id] of Object.entries(priceIds)) {
    if (id === priceId) return plan as BillingPlan;
  }
  return null;
}

/** Stripe's status vocabulary → ours. Anything unknown is treated as incomplete. */
function normalizeStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case 'trialing':
      return 'trialing';
    case 'active':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
      return 'canceled';
    default:
      return 'incomplete';
  }
}

/** Normalize a Stripe subscription object, wherever it arrived from. */
export function snapshotFromSubscription(
  sub: StripeSubscription,
  priceIds: Partial<Record<BillingPlan, string>>,
): SubscriptionSnapshot {
  const customerId = typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? '');
  return {
    customerId,
    subscriptionId: sub.id ?? '',
    plan: planFromPriceId(sub.items?.data?.[0]?.price?.id, priceIds),
    status: normalizeStatus(sub.status),
    currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000) : null,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
  };
}

/**
 * Verify a Stripe webhook signature: `Stripe-Signature: t=<unix>,v1=<hex>`,
 * HMAC-SHA256 over `"<t>.<raw-body>"`.
 *
 * The timestamp is inside the signed string, so a captured POST cannot be
 * replayed once it falls outside the tolerance. A header may carry several `v1`
 * signatures during a secret rotation; any one matching is enough.
 */
export function verifyStripeSignature(
  raw: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  nowMs = Date.now(),
): boolean {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') timestamp = v;
    else if (k === 'v1') signatures.push(v);
  }
  if (!timestamp || !signatures.length) return false;

  const ageMs = nowMs - Number(timestamp) * 1000;
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > toleranceSeconds * 1000) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`, 'utf8')
    .digest();
  return signatures.some((sig) => {
    let given: Buffer;
    try {
      given = Buffer.from(sig, 'hex');
    } catch {
      return false;
    }
    // Length must match before timingSafeEqual, which throws otherwise — and
    // the length itself is not a secret.
    if (given.length !== expected.length) return false;
    return crypto.timingSafeEqual(given, expected);
  });
}

const defaultFetch: StripeFetch = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }) as unknown as ReturnType<StripeFetch>;
