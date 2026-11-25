import { Prisma, prisma } from '@brayz/db';
import type { EligiblePromotion } from '@brayz/shared';
import {
  birthdayWindowActive,
  isVip,
  locationLoyaltySettings,
  winbackEligible,
  type LoyaltySettings,
} from './loyalty.js';

/**
 * Promotion eligibility and discount maths (plan §12.1).
 *
 * Everything money-shaped lives here rather than in the prompt or the model
 * (rule #5). The bot is told which promotions a caller qualifies for and what
 * each is worth in words; the API decides again — and computes the cents —
 * when the order is actually placed.
 */

export interface PromotionRow {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  kind: string;
  percentOff: number | null;
  amountOffCents: number | null;
  minSubtotalCents: number;
  audience: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRedemptions: number | null;
  maxPerGuest: number;
  active: boolean;
}

/** Facts about the caller that audiences are judged against. */
export interface GuestFacts {
  guestId?: string | null;
  lifetimeSpendCents: number;
  birthdayMonth: number | null;
  lastOrderAt: Date | null;
}

/** How a promotion reads out loud. The model is never asked to phrase money. */
export function describeOffer(promo: PromotionRow): string {
  if (promo.kind === 'percent_off' && promo.percentOff) {
    return `${promo.percentOff}% off`;
  }
  const cents = promo.amountOffCents ?? 0;
  return cents % 100 === 0 ? `$${cents / 100} off` : `$${(cents / 100).toFixed(2)} off`;
}

/**
 * What this promotion takes off a given subtotal, in cents.
 *
 * Never more than the subtotal — a promotion may take an order to zero but
 * never below it, which would turn a discount into a payout. `percent_off` can
 * carry `amountOffCents` as a cap, so "20% off, up to $10" is one promotion
 * rather than two rules that disagree.
 */
export function discountFor(promo: PromotionRow, subtotalCents: number): number {
  if (subtotalCents <= 0) return 0;
  let off: number;
  if (promo.kind === 'percent_off' && promo.percentOff) {
    off = Math.floor((subtotalCents * promo.percentOff) / 100);
    if (promo.amountOffCents) off = Math.min(off, promo.amountOffCents);
  } else {
    off = promo.amountOffCents ?? 0;
  }
  return Math.max(0, Math.min(off, subtotalCents));
}

/** Is the promotion switched on and inside its window right now? */
export function isLive(promo: PromotionRow, now = new Date()): boolean {
  if (!promo.active) return false;
  if (promo.startsAt && now < promo.startsAt) return false;
  if (promo.endsAt && now > promo.endsAt) return false;
  return true;
}

/** Does this caller fall in the promotion's audience? */
export function matchesAudience(
  promo: PromotionRow,
  facts: GuestFacts,
  loyalty: LoyaltySettings,
  now = new Date(),
): boolean {
  switch (promo.audience) {
    case 'all':
      return true;
    case 'vip':
      return isVip(facts.lifetimeSpendCents, loyalty);
    case 'birthday':
      return birthdayWindowActive(facts.birthdayMonth, now);
    case 'lapsed':
      // Reuses the win-back rule's definition of "gone quiet", but applies even
      // when win-back *bonus points* are switched off — the two are separate
      // levers a restaurant may want independently.
      return winbackEligible(facts.lastOrderAt, { ...loyalty, winbackEnabled: true }, now);
    default:
      return false;
  }
}

/** Redemption caps, checked against what has actually been redeemed. */
export async function withinCaps(promo: PromotionRow, guestId?: string | null): Promise<boolean> {
  if (promo.maxRedemptions !== null) {
    const total = await prisma.promotionRedemption.count({ where: { promotionId: promo.id } });
    if (total >= promo.maxRedemptions) return false;
  }
  // An anonymous caller can't be held to a per-guest cap; the total cap is the
  // only protection there, which is why one-per-customer offers should carry one.
  if (guestId) {
    const mine = await prisma.promotionRedemption.count({
      where: { promotionId: promo.id, guestId },
    });
    if (mine >= promo.maxPerGuest) return false;
  }
  return true;
}

/** Everything a caller at this location can be offered right now. */
export async function eligiblePromotions(
  locationId: string,
  facts: GuestFacts,
  now = new Date(),
): Promise<EligiblePromotion[]> {
  const [promos, loyalty] = await Promise.all([
    prisma.promotion.findMany({ where: { locationId, active: true } }),
    locationLoyaltySettings(locationId),
  ]);

  const live = promos.filter((p) => isLive(p, now) && matchesAudience(p, facts, loyalty, now));
  const capped = await Promise.all(live.map((p) => withinCaps(p, facts.guestId)));
  return live
    .filter((_, i) => capped[i])
    .map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      offer: describeOffer(p),
      minSubtotalCents: p.minSubtotalCents,
    }));
}

export interface ResolvedPromotion {
  promotion: PromotionRow;
  discountCents: number;
}

/**
 * Resolve the promotion an order asked for, by id or spoken code, and price it.
 * Returns null when it does not apply — the caller decides whether that is an
 * error (the dashboard) or something to tell the guest (a call).
 */
export async function resolvePromotion(
  locationId: string,
  ref: { promotionId?: string; promotionCode?: string },
  facts: GuestFacts,
  subtotalCents: number,
  now = new Date(),
): Promise<ResolvedPromotion | { reason: string } | null> {
  const promo = await prisma.promotion.findFirst({
    where: {
      locationId,
      ...(ref.promotionId
        ? { id: ref.promotionId }
        : { code: (ref.promotionCode ?? '').trim().toUpperCase() }),
    },
  });
  if (!promo) return null;
  if (!isLive(promo, now)) return { reason: 'That offer isn’t running right now' };

  const loyalty = await locationLoyaltySettings(locationId);
  if (!matchesAudience(promo, facts, loyalty, now)) {
    return { reason: 'That offer isn’t available on this order' };
  }
  if (subtotalCents < promo.minSubtotalCents) {
    return {
      reason: `That offer needs an order of at least $${(promo.minSubtotalCents / 100).toFixed(2)}`,
    };
  }
  if (!(await withinCaps(promo, facts.guestId))) {
    return { reason: 'That offer has already been used' };
  }
  return { promotion: promo, discountCents: discountFor(promo, subtotalCents) };
}

/** Did `resolvePromotion` come back with something applicable? */
export function isApplied(
  result: Awaited<ReturnType<typeof resolvePromotion>>,
): result is ResolvedPromotion {
  return !!result && 'promotion' in result;
}

/**
 * Record the redemption inside the order's transaction, so a promotion is never
 * counted against its cap for an order that failed to commit. The unique
 * dedupe key makes a retry of the same order a no-op rather than a second
 * redemption (rule #7).
 */
export async function recordRedemptionInTx(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    promotionId: string;
    guestId?: string | null;
    orderId: string;
    discountCents: number;
  },
): Promise<void> {
  await tx.promotionRedemption.create({
    data: {
      tenantId: args.tenantId,
      promotionId: args.promotionId,
      guestId: args.guestId ?? undefined,
      orderId: args.orderId,
      discountCents: args.discountCents,
      dedupeKey: `promo:${args.orderId}`,
    },
  });
}
