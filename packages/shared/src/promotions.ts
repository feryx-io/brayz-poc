import { z } from 'zod';

/**
 * Promotions (plan §12.1). An offer the AI receptionist may mention on a call
 * and the API may apply to an order.
 *
 * Rule #5 shapes this: the model never computes a discount or decides who
 * qualifies. It is handed the promotions a caller is eligible for, and the API
 * re-checks eligibility and recomputes the money when the order is placed.
 */

export const PromotionKind = z.enum(['percent_off', 'amount_off']);
export type PromotionKind = z.infer<typeof PromotionKind>;

/**
 * Who an offer is for. These reuse the loyalty rules' definitions of VIP and
 * lapsed rather than inventing a second set — a restaurant says what VIP means
 * once, in loyalty settings.
 */
export const PromotionAudience = z.enum(['all', 'vip', 'lapsed', 'birthday']);
export type PromotionAudience = z.infer<typeof PromotionAudience>;

const CodeField = z
  .string()
  .trim()
  .min(2)
  .max(24)
  // Said aloud on a phone call, so keep it to characters a caller can dictate
  // and STT can return without a guess.
  .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers, and hyphens only')
  .transform((v) => v.toUpperCase());

export const PromotionInput = z
  .object({
    code: CodeField.nullish(),
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(280).nullish(),
    kind: PromotionKind,
    percentOff: z.number().int().min(1).max(100).nullish(),
    amountOffCents: z.number().int().min(1).nullish(),
    minSubtotalCents: z.number().int().min(0).default(0),
    audience: PromotionAudience.default('all'),
    startsAt: z.string().datetime().nullish(),
    endsAt: z.string().datetime().nullish(),
    maxRedemptions: z.number().int().min(1).nullish(),
    maxPerGuest: z.number().int().min(1).default(1),
    active: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    // A promotion with no value is a promotion that silently discounts nothing.
    if (val.kind === 'percent_off' && !val.percentOff) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['percentOff'],
        message: 'A percent-off promotion needs a percentage',
      });
    }
    if (val.kind === 'amount_off' && !val.amountOffCents) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['amountOffCents'],
        message: 'An amount-off promotion needs an amount',
      });
    }
    if (val.startsAt && val.endsAt && new Date(val.endsAt) <= new Date(val.startsAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endsAt'],
        message: 'The end must come after the start',
      });
    }
  });
export type PromotionInput = z.infer<typeof PromotionInput>;

/** Every field is optional on a patch, but the same rules apply to what's sent. */
export const PromotionPatch = PromotionInput.innerType().partial();
export type PromotionPatch = z.infer<typeof PromotionPatch>;

/** What the in-call tool hands the model: enough to offer it, no arithmetic. */
export const EligiblePromotion = z.object({
  id: z.string(),
  code: z.string().nullable(),
  name: z.string(),
  description: z.string().nullable(),
  /** Already-worded, e.g. "$5 off" or "15% off" — the model never computes this. */
  offer: z.string(),
  minSubtotalCents: z.number().int(),
});
export type EligiblePromotion = z.infer<typeof EligiblePromotion>;
