import { prisma } from '@brayz/db';
import {
  StripeBillingProvider,
  accessFor,
  type AccessSource,
  type BillingProvider,
} from '@brayz/billing';
import type { BillingPlan, Entitlement, SubscriptionStatus } from '@brayz/shared';
import { loadConfig } from '@brayz/config';
import { HttpError } from './http.js';
import { toSipUri } from './sip.js';

/**
 * Billing state for a location, and the gate that turns a plan into permission.
 *
 * Three decisions worth knowing about:
 *
 * - **An account from before trials, with no subscription, is fully entitled.**
 *   Every such location predates billing; making the gate deny by default would
 *   switch off working restaurants. `BILLING_ENFORCED=true` gates plan tiers
 *   once real plans exist, and even then leaves an unsubscribed one alone.
 * - **A new account runs on its free trial** (`accessFor` in @brayz/billing):
 *   Pro everywhere until the trial ends — and once it has lapsed with nothing
 *   paid for, the account is **out of service**, whatever BILLING_ENFORCED says.
 *   That flag is about which tier includes what; this is an account that chose
 *   not to pay. The AI stops answering its calls (see locationService).
 * - **`past_due` keeps working.** A failed card must not stop a restaurant's
 *   phone being answered mid-service. Stripe dunning chases it; cancellation is
 *   what actually ends service.
 */

const DAY_MS = 86_400_000;

export interface TrialInfo {
  startedAt: Date | null;
  endsAt: Date;
  active: boolean;
  /** Whole days left, rounded up; 0 once it has ended. */
  daysLeft: number;
}

export interface LocationBilling {
  /** The plan the location is served on: the paid one, or Pro during a trial. */
  plan: BillingPlan | null;
  status: SubscriptionStatus;
  entitlements: Entitlement[];
  stripeCustomerId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /** No subscription row at all — never been through checkout. */
  unsubscribed: boolean;
  source: AccessSource;
  /** False once the account's trial has lapsed with no paid plan. */
  inService: boolean;
  /** The account's free trial, or null for an account from before trials. */
  trial: TrialInfo | null;
}

export function trialInfo(startedAt: Date | null, endsAt: Date | null, now = new Date()): TrialInfo | null {
  if (!endsAt) return null;
  const left = endsAt.getTime() - now.getTime();
  return { startedAt, endsAt, active: left > 0, daysLeft: left > 0 ? Math.ceil(left / DAY_MS) : 0 };
}

export async function locationBilling(locationId: string, now = new Date()): Promise<LocationBilling> {
  const [row, location] = await Promise.all([
    prisma.locationSubscription.findUnique({ where: { locationId } }),
    prisma.location.findUnique({
      where: { id: locationId },
      select: { tenant: { select: { trialStartedAt: true, trialEndsAt: true } } },
    }),
  ]);
  const status = (row?.status ?? 'none') as SubscriptionStatus;
  const trialEndsAt = location?.tenant.trialEndsAt ?? null;
  const access = accessFor({
    plan: (row?.plan ?? null) as BillingPlan | null,
    status,
    trialEndsAt,
    now,
  });
  return {
    plan: access.plan,
    status,
    entitlements: access.entitlements,
    stripeCustomerId: row?.stripeCustomerId ?? null,
    currentPeriodEnd: row?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
    unsubscribed: !row || status === 'none',
    source: access.source,
    inService: access.inService,
    trial: trialInfo(location?.tenant.trialStartedAt ?? null, trialEndsAt, now),
  };
}

/**
 * Throw unless the location may use a feature. Call this at the top of a route
 * that sells something, so the plan is enforced where the work happens rather
 * than only in the UI that offers it.
 */
export async function requireEntitlement(
  locationId: string,
  entitlement: Entitlement,
): Promise<void> {
  const billing = await locationBilling(locationId);
  if (billing.source === 'trial_expired') {
    throw new HttpError(
      402,
      'This restaurant’s free trial has ended — choose a plan to turn Brayz back on',
      'trial_expired',
    );
  }
  // A running trial is Pro, which includes everything.
  if (billing.source === 'trial') return;
  const cfg = loadConfig();
  if (!cfg.BILLING_ENFORCED) return;
  // An unsubscribed location keeps working even under enforcement: enforcement
  // is about plan tiers, not about locking out anyone who hasn't onboarded.
  if (billing.unsubscribed) return;
  if (!billing.entitlements.includes(entitlement)) {
    throw new HttpError(
      402,
      `This location's plan does not include ${entitlement.replace('_', ' ')}`,
      'plan_upgrade_required',
    );
  }
}

export interface LocationService {
  inService: boolean;
  reason: 'trial_expired' | null;
  /**
   * Where an out-of-service call goes instead of the AI: the restaurant's own
   * phone, as a SIP URI SiphonAI can REFER to — the first enabled transfer
   * target, else the escalation phone. Null when there is none, or it is a bare
   * number and no BRAYZ_TRANSFER_SIP_DOMAIN is set; the caller is then told the
   * call cannot be taken.
   */
  forwardTo: string | null;
}

/** Whether the AI should take a call for this location, and where it goes if not. */
export async function locationService(locationId: string): Promise<LocationService> {
  const billing = await locationBilling(locationId);
  if (billing.inService) return { inService: true, reason: null, forwardTo: null };

  const domain = loadConfig().BRAYZ_TRANSFER_SIP_DOMAIN;
  const [targets, location] = await Promise.all([
    prisma.locationTransferTarget.findMany({
      where: { locationId, enabled: true },
      orderBy: { sortOrder: 'asc' },
      select: { destination: true },
    }),
    prisma.location.findUnique({ where: { id: locationId }, select: { escalationPhone: true } }),
  ]);
  const candidates = [...targets.map((t) => t.destination), location?.escalationPhone];
  const forwardTo =
    candidates
      .filter((d): d is string => Boolean(d?.trim()))
      .map((d) => toSipUri(d.trim(), domain))
      .find((uri): uri is string => uri !== null) ?? null;
  return { inService: false, reason: 'trial_expired', forwardTo };
}

/** Calls and AI minutes for the location's current billing period. */
export async function usageForPeriod(
  locationId: string,
  since: Date,
): Promise<{ calls: number; aiMinutes: number; since: Date }> {
  const calls = await prisma.call.findMany({
    where: { locationId, startedAt: { gte: since } },
    select: { startedAt: true, endedAt: true, answeredAt: true },
  });
  // Metered from answer to hang-up: an unanswered call costs no AI. A call
  // still running contributes what it has run so far, so the figure never
  // jumps backwards when it ends.
  const now = Date.now();
  const seconds = calls.reduce((sum, c) => {
    const start = c.answeredAt ?? c.startedAt;
    if (!start) return sum;
    const end = c.endedAt?.getTime() ?? now;
    return sum + Math.max(0, (end - start.getTime()) / 1000);
  }, 0);
  return { calls: calls.length, aiMinutes: Math.round(seconds / 60), since };
}

/** The start of the current period: Stripe's when we know it, else this month. */
export function periodStart(currentPeriodEnd: Date | null, now = new Date()): Date {
  if (currentPeriodEnd) {
    const start = new Date(currentPeriodEnd);
    start.setMonth(start.getMonth() - 1);
    if (start <= now) return start;
  }
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** The configured processor, or null when Stripe keys are absent. */
export function buildBillingProvider(): BillingProvider | null {
  const cfg = loadConfig();
  if (!cfg.STRIPE_SECRET_KEY) return null;
  return new StripeBillingProvider({
    secretKey: cfg.STRIPE_SECRET_KEY,
    priceIds: {
      starter: cfg.STRIPE_PRICE_STARTER,
      growth: cfg.STRIPE_PRICE_GROWTH,
      pro: cfg.STRIPE_PRICE_PRO,
    },
  });
}
