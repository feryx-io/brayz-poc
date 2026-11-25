import type { FastifyInstance } from 'fastify';
import { LocationLoyaltySettingsInput } from '@brayz/shared';
import { forTenant, prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import {
  LOYALTY_DEFAULTS,
  birthdayBonusClaimed,
  birthdayWindowActive,
  isVip,
  locationLoyaltySettings,
  winbackEligible,
} from '../lib/loyalty.js';
import { locationGuestMemoryMode } from '../lib/guests.js';
import { requireNode } from '../auth/node.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

/**
 * Loyalty (Phase 6 MVP). Dashboard side: per-location program config and a
 * guest's account/ledger. Voice plane: a node-authed, callId-keyed status the
 * bot relays — gated exactly like guest memory (CLAUDE.md rule #6: never reveal
 * loyalty data on a voice match alone; the gates are enforced here, in code).
 */
export async function loyaltyRoutes(app: FastifyInstance): Promise<void> {
  // ---- Dashboard: program settings (mirror of ai-settings) ----
  app.get('/v1/locations/:locationId/loyalty-settings', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const settings = await prisma.locationLoyaltySettings.findUnique({ where: { locationId } });
    return settings ?? { locationId, ...LOYALTY_DEFAULTS };
  });

  app.put('/v1/locations/:locationId/loyalty-settings', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const input = parse(LocationLoyaltySettingsInput, request.body);
    return prisma.locationLoyaltySettings.upsert({
      where: { locationId },
      update: input,
      create: { locationId, ...input },
    });
  });

  // ---- Dashboard: program analytics for a location ----
  app.get('/v1/locations/:locationId/loyalty-stats', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const settings = await locationLoyaltySettings(locationId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const accountWhere = { tenantId, guest: { locationId } };
    const [members, vipCount, outstanding, byType, discounts] = await Promise.all([
      prisma.loyaltyAccount.count({ where: accountWhere }),
      settings.vipEnabled
        ? prisma.loyaltyAccount.count({
            where: { ...accountWhere, lifetimeSpendCents: { gte: settings.vipSpendCents } },
          })
        : Promise.resolve(0),
      prisma.loyaltyAccount.aggregate({ where: accountWhere, _sum: { pointsBalance: true } }),
      prisma.loyaltyEvent.groupBy({
        by: ['type'],
        where: { tenantId, account: { guest: { locationId } }, createdAt: { gte: since } },
        _sum: { points: true },
        _count: { _all: true },
      }),
      // Reward discounts show up as subtotal − total on the order rows.
      prisma.order.aggregate({
        where: { tenantId, locationId, createdAt: { gte: since } },
        _sum: { subtotalCents: true, totalCents: true },
      }),
    ]);

    // What the bot's add-on suggestions actually brought in. Priced from the
    // stored line, not recomputed, so it matches what the guest was charged.
    const upsellLines = await prisma.orderItem.findMany({
      where: {
        viaUpsell: true,
        order: { tenantId, locationId, createdAt: { gte: since } },
      },
      select: { quantity: true, unitPriceCents: true },
    });
    const upsellRevenueCents = upsellLines.reduce(
      (sum, l) => sum + l.quantity * l.unitPriceCents,
      0,
    );

    const typed = Object.fromEntries(
      byType.map((r) => [r.type, { points: r._sum.points ?? 0, count: r._count._all }]),
    ) as Record<string, { points: number; count: number }>;
    return {
      enabled: settings.enabled,
      members,
      vipCount,
      pointsOutstanding: outstanding._sum.pointsBalance ?? 0,
      last30Days: {
        pointsEarned: typed.earn?.points ?? 0,
        redemptions: typed.redeem?.count ?? 0,
        pointsRedeemed: Math.abs(typed.redeem?.points ?? 0),
        birthdayBonuses: typed.birthday?.count ?? 0,
        winbackBonuses: typed.winback?.count ?? 0,
        discountCents:
          (discounts._sum.subtotalCents ?? 0) - (discounts._sum.totalCents ?? 0),
        upsellItems: upsellLines.length,
        upsellRevenueCents,
      },
    };
  });

  // ---- Dashboard: a guest's account + recent ledger ----
  app.get('/v1/guests/:guestId/loyalty', async (request) => {
    const tenantId = requireTenant(request);
    const { guestId } = request.params as { guestId: string };
    const db = forTenant(tenantId);
    const guest = await db.guest.findFirst({ where: { id: guestId }, select: { id: true } });
    if (!guest) throw notFound('Guest');
    const account = await db.loyaltyAccount.findFirst({
      where: { guestId },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!account) {
      return { pointsBalance: 0, lifetimePoints: 0, lifetimeSpendCents: 0, events: [] };
    }
    return {
      pointsBalance: account.pointsBalance,
      lifetimePoints: account.lifetimePoints,
      lifetimeSpendCents: account.lifetimeSpendCents,
      events: account.events.map((e) => ({
        type: e.type,
        points: e.points,
        orderId: e.orderId,
        note: e.note,
        createdAt: e.createdAt,
      })),
    };
  });

  // ---- Voice plane: loyalty status for the current caller ----
  // Withheld (403) when guest memory is off or the guest opted out — same gate
  // as guest/details; in 'confirm' mode the prompt requires an identity confirm
  // before the bot calls this.
  app.get('/v1/calls/:callId/tools/loyalty', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { locationId: true, guestId: true },
    });
    if (!call) throw notFound('Call');

    const settings = await locationLoyaltySettings(call.locationId);
    if (!settings.enabled) return { enabled: false };

    const mode = await locationGuestMemoryMode(call.locationId);
    if (mode === 'off') {
      throw new HttpError(403, 'Loyalty status is not available', 'loyalty_unavailable');
    }
    if (!call.guestId) {
      // First-time caller: no account yet, nothing personal to reveal.
      return {
        enabled: true,
        enrolled: false,
        pointsBalance: 0,
        rewardAvailable: false,
        rewardPoints: settings.rewardPoints,
        rewardCents: settings.rewardCents,
        pointsPerDollar: settings.pointsPerDollar,
      };
    }
    const guest = await prisma.guest.findUnique({
      where: { id: call.guestId },
      select: { memoryEnabled: true, birthdayMonth: true },
    });
    if (!guest || !guest.memoryEnabled) {
      throw new HttpError(403, 'Loyalty status is not available', 'loyalty_unavailable');
    }
    const [account, lastOrder] = await Promise.all([
      prisma.loyaltyAccount.findUnique({
        where: { guestId: call.guestId },
        select: { pointsBalance: true, lifetimeSpendCents: true },
      }),
      prisma.order.findFirst({
        where: { guestId: call.guestId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
    ]);
    const balance = account?.pointsBalance ?? 0;
    const birthdayBonusAvailable =
      settings.birthdayEnabled &&
      birthdayWindowActive(guest.birthdayMonth) &&
      !(await birthdayBonusClaimed(call.guestId));
    return {
      enabled: true,
      enrolled: !!account,
      pointsBalance: balance,
      rewardAvailable: balance >= settings.rewardPoints,
      rewardPoints: settings.rewardPoints,
      rewardCents: settings.rewardCents,
      pointsPerDollar: settings.pointsPerDollar,
      vip: isVip(account?.lifetimeSpendCents ?? 0, settings),
      birthdayBonusAvailable,
      birthdayBonusPoints: birthdayBonusAvailable ? settings.birthdayBonusPoints : 0,
      winbackBonusAvailable: winbackEligible(lastOrder?.createdAt, settings),
      winbackBonusPoints: winbackEligible(lastOrder?.createdAt, settings)
        ? settings.winbackBonusPoints
        : 0,
    };
  });
}

/** Verify the location belongs to the active tenant. */
async function assertLocation(tenantId: string, locationId: string) {
  const db = forTenant(tenantId);
  const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!location) throw notFound('Location');
}
