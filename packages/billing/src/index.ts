import type { BillingPlan, Entitlement, SubscriptionStatus } from '@brayz/shared';

/**
 * Billing abstraction (CLAUDE.md rule #2). Stripe is the first implementation,
 * not the platform model: the API talks to `BillingProvider`, and a second
 * processor would be a new adapter here and nothing else.
 *
 * The plan catalog and the entitlement rules live in this package too, because
 * they are the same question asked twice — "what does this location pay for"
 * and "what may this location do".
 */

export interface PlanDefinition {
  plan: BillingPlan;
  name: string;
  /** Advertised price, for the dashboard. Stripe holds the price of record. */
  monthlyCents: number;
  /** One line the owner reads when choosing. */
  summary: string;
  entitlements: Entitlement[];
  /** Calls included per month; over this the add-on rate applies. */
  includedCalls: number;
}

/**
 * Pricing per the development plan §10. `monthlyCents` is what the dashboard
 * shows; the amount actually charged is whatever the Stripe price says, so a
 * change made in Stripe is never silently contradicted here.
 */
export const PLANS: Record<BillingPlan, PlanDefinition> = {
  starter: {
    plan: 'starter',
    name: 'Starter',
    monthlyCents: 9900,
    summary: 'Every call answered, with summaries and transfers.',
    entitlements: ['calls'],
    includedCalls: 300,
  },
  growth: {
    plan: 'growth',
    name: 'Growth',
    monthlyCents: 24900,
    summary: 'Adds pickup and delivery orders, guest memory, and loyalty.',
    entitlements: ['calls', 'orders', 'guest_memory', 'loyalty'],
    includedCalls: 1000,
  },
  pro: {
    plan: 'pro',
    name: 'Pro',
    monthlyCents: 49900,
    summary: 'Adds staff voices, targeted promotions, and POS integrations.',
    entitlements: [
      'calls',
      'orders',
      'guest_memory',
      'loyalty',
      'promotions',
      'staff_voices',
      'pos',
    ],
    includedCalls: 3000,
  },
};

/** Statuses that still entitle a location to service. */
const SERVICEABLE: SubscriptionStatus[] = ['trialing', 'active', 'past_due'];

/**
 * What a location may do right now.
 *
 * `past_due` keeps working on purpose: a failed card must not silently stop a
 * restaurant's phone from being answered mid-service. Dunning is Stripe's job,
 * and cancellation is the lever that actually cuts service off.
 */
export function entitlementsFor(
  plan: BillingPlan | null | undefined,
  status: SubscriptionStatus,
): Entitlement[] {
  if (!plan || !SERVICEABLE.includes(status)) return [];
  return PLANS[plan].entitlements;
}

export function isEntitled(
  plan: BillingPlan | null | undefined,
  status: SubscriptionStatus,
  entitlement: Entitlement,
): boolean {
  return entitlementsFor(plan, status).includes(entitlement);
}

/** The cheapest plan that includes something, for an upgrade prompt. */
export function planIncluding(entitlement: Entitlement): PlanDefinition | null {
  const order: BillingPlan[] = ['starter', 'growth', 'pro'];
  for (const p of order) {
    if (PLANS[p].entitlements.includes(entitlement)) return PLANS[p];
  }
  return null;
}

/** A plan that is paid for and still in a state that serves calls. */
export function isPaidAndServiceable(plan: BillingPlan | null | undefined, status: SubscriptionStatus): boolean {
  return !!plan && SERVICEABLE.includes(status);
}

/** Every new account's free trial: this many days of this plan, on every location it opens. */
export const TRIAL_DAYS = 30;
export const TRIAL_PLAN: BillingPlan = 'pro';

/**
 * Where a location's access comes from:
 *
 * - `subscription` — a paid plan in a serviceable state. It always wins.
 * - `trial` — no paid plan, but the account's free trial is running: TRIAL_PLAN.
 * - `trial_expired` — the trial ran out and nothing is paid for: out of service,
 *   the AI does not answer the location's calls.
 * - `unrestricted` — an account from before trials existed. It keeps exactly the
 *   access it always had (see requireEntitlement in the API).
 */
export type AccessSource = 'subscription' | 'trial' | 'trial_expired' | 'unrestricted';

export interface Access {
  source: AccessSource;
  /** The plan the location is served on: the paid one, or TRIAL_PLAN during a trial. */
  plan: BillingPlan | null;
  entitlements: Entitlement[];
  /** False only once a trial has lapsed with no paid plan. */
  inService: boolean;
}

/**
 * What a location may do, trial included. Pure, so the rules live in one tested
 * place and the entitlement gate, the call path and the dashboard all get the
 * same answer. A trial ends at its end instant, not at the end of that day.
 */
export function accessFor(args: {
  plan: BillingPlan | null;
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  now: Date;
}): Access {
  const { plan, status, trialEndsAt, now } = args;
  if (plan && isPaidAndServiceable(plan, status)) {
    return { source: 'subscription', plan, entitlements: PLANS[plan].entitlements, inService: true };
  }
  if (trialEndsAt) {
    return now < trialEndsAt
      ? { source: 'trial', plan: TRIAL_PLAN, entitlements: PLANS[TRIAL_PLAN].entitlements, inService: true }
      : { source: 'trial_expired', plan: null, entitlements: [], inService: false };
  }
  return { source: 'unrestricted', plan, entitlements: entitlementsFor(plan, status), inService: true };
}

export interface CheckoutRequest {
  plan: BillingPlan;
  locationId: string;
  tenantId: string;
  /** Reused across a location's subscriptions once Stripe has minted one. */
  customerId?: string;
  customerEmail?: string;
  returnUrl: string;
  /**
   * The end of the account's free trial when one is still running: the paid
   * subscription starts billing then, so paying early never costs trial days.
   */
  trialEndsAt?: Date;
}

export interface CheckoutSession {
  /** Where to send the owner to pay. */
  url: string;
  sessionId: string;
}

export interface PortalRequest {
  customerId: string;
  returnUrl: string;
}

/** What a processor tells us about a subscription, normalized. */
export interface SubscriptionSnapshot {
  customerId: string;
  subscriptionId: string;
  plan: BillingPlan | null;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface BillingProvider {
  readonly name: string;
  /** Start a hosted checkout for a plan. */
  createCheckout(req: CheckoutRequest): Promise<CheckoutSession>;
  /** A hosted portal where the owner manages card, plan, and cancellation. */
  createPortal(req: PortalRequest): Promise<{ url: string }>;
  /** Read a subscription back, e.g. to reconcile after a missed webhook. */
  getSubscription(subscriptionId: string): Promise<SubscriptionSnapshot | null>;
}

/** The processor rejected the request; retrying it unchanged will not help. */
export class BillingConfigError extends Error {
  readonly code = 'billing_not_configured';
  constructor(message: string) {
    super(message);
    this.name = 'BillingConfigError';
  }
}

export class BillingProviderError extends Error {
  readonly code = 'billing_provider_error';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'BillingProviderError';
  }
}

export {
  StripeBillingProvider,
  planFromPriceId,
  snapshotFromSubscription,
  verifyStripeSignature,
} from './stripe.js';
export type { StripeConfig, StripeFetch } from './stripe.js';
