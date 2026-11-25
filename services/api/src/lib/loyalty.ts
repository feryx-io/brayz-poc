/**
 * Loyalty engine (Phase 6 MVP): points per dollar on confirmed orders, plus a
 * flat reward (rewardPoints → rewardCents off). Balances live on LoyaltyAccount;
 * every change writes a LoyaltyEvent with a dedupe key so Pub/Sub redelivery or
 * an orchestrator retry can never double-award or double-redeem (rule #7).
 */
import { Prisma, prisma } from '@brayz/db';

export interface LoyaltySettings {
  enabled: boolean;
  pointsPerDollar: number;
  rewardPoints: number;
  rewardCents: number;
  vipEnabled: boolean;
  vipSpendCents: number;
  vipPointsMultiplier: number;
  birthdayEnabled: boolean;
  birthdayBonusPoints: number;
  winbackEnabled: boolean;
  winbackDays: number;
  winbackBonusPoints: number;
}

export const LOYALTY_DEFAULTS: LoyaltySettings = {
  enabled: false,
  pointsPerDollar: 10,
  rewardPoints: 500,
  rewardCents: 500,
  vipEnabled: false,
  vipSpendCents: 50_000,
  vipPointsMultiplier: 2,
  birthdayEnabled: false,
  birthdayBonusPoints: 200,
  winbackEnabled: false,
  winbackDays: 60,
  winbackBonusPoints: 200,
};

/** The location's program config (defaults to disabled when never configured). */
export async function locationLoyaltySettings(locationId: string): Promise<LoyaltySettings> {
  const s = await prisma.locationLoyaltySettings.findUnique({
    where: { locationId },
    select: {
      enabled: true,
      pointsPerDollar: true,
      rewardPoints: true,
      rewardCents: true,
      vipEnabled: true,
      vipSpendCents: true,
      vipPointsMultiplier: true,
      birthdayEnabled: true,
      birthdayBonusPoints: true,
      winbackEnabled: true,
      winbackDays: true,
      winbackBonusPoints: true,
    },
  });
  return s ?? LOYALTY_DEFAULTS;
}

/** VIP rule: lifetime spend at/over the threshold (computed, never stored). */
export function isVip(lifetimeSpendCents: number, settings: LoyaltySettings): boolean {
  return settings.vipEnabled && lifetimeSpendCents >= settings.vipSpendCents;
}

/** Points a confirmed order earns under the given settings (VIPs earn multiplied). */
export function pointsForOrder(totalCents: number, settings: LoyaltySettings, vip = false): number {
  const base = Math.floor(totalCents / 100) * settings.pointsPerDollar;
  return vip ? base * settings.vipPointsMultiplier : base;
}

/**
 * Award points for a confirmed order. Idempotent per order — a replay finds the
 * existing earn event and no-ops. Creates the account on first earn.
 */
export async function awardPointsForOrder(args: {
  tenantId: string;
  guestId: string;
  orderId: string;
  totalCents: number;
  settings: LoyaltySettings;
  /** Earn at the VIP multiplier (caller computes status from pre-order spend). */
  vip?: boolean;
}): Promise<{ points: number; awarded: boolean }> {
  const { tenantId, guestId, orderId, totalCents, settings, vip } = args;
  if (!settings.enabled) return { points: 0, awarded: false };
  const points = pointsForOrder(totalCents, settings, vip);
  if (points <= 0) return { points: 0, awarded: false };

  const dedupeKey = `loyalty-earn:${orderId}`;
  try {
    await prisma.$transaction(async (tx) => {
      const account = await tx.loyaltyAccount.upsert({
        where: { guestId },
        update: {},
        create: { tenantId, guestId },
        select: { id: true },
      });
      await tx.loyaltyEvent.create({
        data: { tenantId, accountId: account.id, type: 'earn', points, orderId, dedupeKey },
      });
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: {
          pointsBalance: { increment: points },
          lifetimePoints: { increment: points },
          lifetimeSpendCents: { increment: totalCents },
        },
      });
    });
    return { points, awarded: true };
  } catch (err) {
    // Replayed order (dedupeKey already used) — the points are already on the account.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { points, awarded: false };
    }
    throw err;
  }
}

/**
 * Move a guest's points to match a changed order.
 *
 * The ledger is append-only, so the difference between what the order was
 * worth and what it is worth now is its own entry rather than a rewrite of the
 * earn. Keyed on the order revision the change made, so replaying the same
 * change cannot double it, and a later change writes its own entry — even one
 * back to a total the order has had before.
 */
export async function adjustPointsForOrder(args: {
  tenantId: string;
  guestId: string;
  orderId: string;
  fromCents: number;
  toCents: number;
  /** The order's revision after the change. */
  revision: number;
  settings: LoyaltySettings;
  vip?: boolean;
}): Promise<{ points: number; adjusted: boolean }> {
  const { tenantId, guestId, orderId, fromCents, toCents, revision, settings, vip } = args;
  if (!settings.enabled) return { points: 0, adjusted: false };
  const points = pointsForOrder(toCents, settings, vip) - pointsForOrder(fromCents, settings, vip);
  const spend = toCents - fromCents;
  if (points === 0 && spend === 0) return { points: 0, adjusted: false };

  const dedupeKey = `loyalty-earn-change:${orderId}:r${revision}`;
  try {
    await prisma.$transaction(async (tx) => {
      const account = await tx.loyaltyAccount.upsert({
        where: { guestId },
        update: {},
        create: { tenantId, guestId },
        select: { id: true },
      });
      await tx.loyaltyEvent.create({
        data: {
          tenantId,
          accountId: account.id,
          // An "earn" of a negative number rather than a type of its own: every
          // reader of this ledger already sums earns, and a new type would have
          // to be taught to all of them to mean the same thing.
          type: 'earn',
          points,
          orderId,
          note: 'Order changed',
          dedupeKey,
        },
      });
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: {
          pointsBalance: { increment: points },
          lifetimePoints: { increment: Math.max(0, points) },
          lifetimeSpendCents: { increment: spend },
        },
      });
    });
    return { points, adjusted: true };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { points, adjusted: false };
    }
    throw err;
  }
}

/** True when the guest's birthday month matches `now` (restaurant-local time is
 *  a later refinement — server time is close enough for a monthly window). */
export function birthdayWindowActive(birthdayMonth: number | null | undefined, now = new Date()): boolean {
  return birthdayMonth != null && birthdayMonth === now.getMonth() + 1;
}

/** True when the guest's previous order is at least winbackDays old. */
export function winbackEligible(
  lastOrderAt: Date | null | undefined,
  settings: LoyaltySettings,
  now = new Date(),
): boolean {
  if (!settings.winbackEnabled || !lastOrderAt) return false;
  return now.getTime() - lastOrderAt.getTime() >= settings.winbackDays * 24 * 60 * 60 * 1000;
}

/** The dedupe key that limits the birthday bonus to once per calendar year. */
export function birthdayDedupeKey(guestId: string, now = new Date()): string {
  return `loyalty-birthday:${guestId}:${now.getFullYear()}`;
}

/** Has the birthday bonus already been claimed this calendar year? */
export async function birthdayBonusClaimed(guestId: string, now = new Date()): Promise<boolean> {
  const seen = await prisma.loyaltyEvent.findUnique({
    where: { dedupeKey: birthdayDedupeKey(guestId, now) },
    select: { id: true },
  });
  return !!seen;
}

/**
 * Award a bonus (birthday / winback) idempotently: the dedupe key makes a replay
 * a no-op. Runs in its own transaction, separate from the base earn, so a lost
 * race never rolls back the earn.
 */
export async function awardBonus(args: {
  tenantId: string;
  guestId: string;
  type: 'birthday' | 'winback';
  points: number;
  dedupeKey: string;
  orderId?: string;
  note?: string;
}): Promise<boolean> {
  const { tenantId, guestId, type, points, dedupeKey, orderId, note } = args;
  if (points <= 0) return false;
  try {
    await prisma.$transaction(async (tx) => {
      const account = await tx.loyaltyAccount.upsert({
        where: { guestId },
        update: {},
        create: { tenantId, guestId },
        select: { id: true },
      });
      await tx.loyaltyEvent.create({
        data: { tenantId, accountId: account.id, type, points, orderId, note, dedupeKey },
      });
      await tx.loyaltyAccount.update({
        where: { id: account.id },
        data: { pointsBalance: { increment: points }, lifetimePoints: { increment: points } },
      });
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return false; // already awarded (replay or concurrent call)
    }
    throw err;
  }
}

/**
 * Redeem the reward inside an order-create transaction: deducts rewardPoints and
 * records the redeem event. The caller must have verified eligibility first and
 * computed the discount; the balance guard here makes a concurrent double-spend
 * impossible (updateMany matches zero rows once the balance is too low).
 */
export async function redeemRewardInTx(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; guestId: string; orderId: string; settings: LoyaltySettings },
): Promise<void> {
  const { tenantId, guestId, orderId, settings } = args;
  const account = await tx.loyaltyAccount.findUnique({
    where: { guestId },
    select: { id: true },
  });
  if (!account) throw new Error('loyalty account missing at redeem time');
  const spent = await tx.loyaltyAccount.updateMany({
    where: { id: account.id, pointsBalance: { gte: settings.rewardPoints } },
    data: { pointsBalance: { decrement: settings.rewardPoints } },
  });
  if (spent.count === 0) throw new Error('insufficient points at redeem time');
  await tx.loyaltyEvent.create({
    data: {
      tenantId,
      accountId: account.id,
      type: 'redeem',
      points: -settings.rewardPoints,
      orderId,
      dedupeKey: `loyalty-redeem:${orderId}`,
    },
  });
}
