import { z } from 'zod';

/**
 * Billing contracts (plan §12.5, pricing §10). Subscriptions are **per
 * location** — a two-site restaurant pays twice and can sit on different tiers,
 * because the value Brayz delivers is per phone line.
 */

export const BillingPlan = z.enum(['starter', 'growth', 'pro']);
export type BillingPlan = z.infer<typeof BillingPlan>;

/**
 * Mirrors Stripe's subscription statuses, plus `none` for a location that has
 * never subscribed. Kept as our own enum so the rest of Brayz never has to know
 * Stripe's vocabulary (rule #2).
 */
export const SubscriptionStatus = z.enum([
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/**
 * What a plan unlocks. Gating lives in code rather than in a description
 * somewhere, so "Growth includes order taking" is a fact the API enforces.
 */
export const Entitlement = z.enum([
  // Answer calls, take messages, transfer — every plan.
  'calls',
  // Take pickup and delivery orders on a call.
  'orders',
  // Recognize returning guests and remember preferences.
  'guest_memory',
  // Points, rewards, VIP.
  'loyalty',
  // Targeted offers.
  'promotions',
  // Cloned staff voices.
  'staff_voices',
  // POS integrations.
  'pos',
]);
export type Entitlement = z.infer<typeof Entitlement>;

export const CheckoutInput = z.object({
  plan: BillingPlan,
  /** Where Stripe returns the owner afterwards. */
  returnUrl: z.string().url(),
});
export type CheckoutInput = z.infer<typeof CheckoutInput>;

export const PortalInput = z.object({ returnUrl: z.string().url() });
export type PortalInput = z.infer<typeof PortalInput>;

/** ---- Free trial (staff side) ---- */

/**
 * Brayz staff extending a customer's free trial — or starting one for an
 * account that never had one. Either days to add (from the later of now and
 * the current end, so a lapsed trial restarts from today) or an exact end, and
 * always a reason: it is kept with the change in the staff audit trail.
 */
export const ExtendTrialInput = z
  .object({
    days: z.number().int().min(1).max(90).optional(),
    endsAt: z.coerce.date().optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine((v) => (v.days === undefined) !== (v.endsAt === undefined), {
    message: 'Give either days or endsAt, not both',
  });
export type ExtendTrialInput = z.infer<typeof ExtendTrialInput>;

/** The staff Trials screen's filter. `ending` is an active trial with a week or less left. */
export const TrialListState = z.enum(['all', 'active', 'ending', 'expired', 'converted']);
export type TrialListState = z.infer<typeof TrialListState>;
