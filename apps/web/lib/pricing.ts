import type { BillingPlan } from '@brayz/shared';

/**
 * What the marketing page says each plan costs and includes.
 *
 * The prices, names, call allowances and summaries here must agree with `PLANS`
 * in `@brayz/billing`, which is what Stripe actually bills against — a landing
 * page quoting $199 for a plan that charges $249 is a problem no amount of
 * copy-editing catches. `apps/web/test/pricing.test.ts` fails the build if they
 * drift.
 *
 * The billing package is not imported here on purpose: this module is pulled
 * into the marketing page, and the plan catalogue is the only part of billing
 * that belongs in front of a logged-out visitor. The bullets below are
 * marketing copy and have no counterpart in billing, so they live only here.
 */
export interface LandingPlan {
  plan: BillingPlan;
  name: string;
  monthlyCents: number;
  includedCalls: number;
  summary: string;
  /** Marketing bullets — copy, not entitlements. */
  items: string[];
  featured?: boolean;
}

export const LANDING_PLANS: LandingPlan[] = [
  {
    plan: 'starter',
    name: 'Starter',
    monthlyCents: 9900,
    includedCalls: 300,
    summary: 'Every call answered, with summaries and transfers.',
    items: [
      'AI receptionist, 24/7',
      'Hours, menu and location questions',
      'Call summaries and transcripts',
      'Transfer to staff',
    ],
  },
  {
    plan: 'growth',
    name: 'Growth',
    monthlyCents: 24900,
    includedCalls: 1000,
    summary: 'Adds pickup and delivery orders, guest memory, and loyalty.',
    items: [
      'Everything in Starter',
      'Pickup and delivery orders to the kitchen',
      'Guests remembered by number',
      'Loyalty points and rewards',
    ],
    featured: true,
  },
  {
    plan: 'pro',
    name: 'Pro',
    monthlyCents: 49900,
    includedCalls: 3000,
    summary: 'Adds staff voices, targeted promotions, and POS integrations.',
    items: ['Everything in Growth', 'Staff voice personas', 'Targeted promotions', 'POS integration'],
  },
];

/**
 * The free trial every new account starts on, as the marketing page promises
 * it. Held to `TRIAL_DAYS` / `TRIAL_PLAN` in `@brayz/billing` by the same test,
 * for the same reason: a page promising 30 days when sign-up grants 14 is a
 * broken promise, not a typo.
 */
export const LANDING_TRIAL: { days: number; plan: BillingPlan; planName: string } = {
  days: 30,
  plan: 'pro',
  planName: 'Pro',
};

/** "$99" for a whole number of dollars, "$99.50" otherwise. */
export function formatMonthly(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "1,000 calls a month" */
export function formatIncludedCalls(calls: number): string {
  return `${calls.toLocaleString('en-US')} calls a month`;
}
