import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ChangeOrderInput, CreateOrderInput, ListOrdersQuery, OrderCountQuery, UpdateOrderStatusInput,
  formatDeliveryAddress,
  guestOrderReadySms,
  modifierLabel,
  portionPriceCents,
} from '@brayz/shared';
import {
  addressJson,
  checkDeliveryArea,
  DELIVERY_LOCATION_SELECT,
  saveGuestDeliveryAddress,
  type AreaResult,
} from '../lib/delivery.js';
import type { GeocodingProvider } from '../lib/geocoding.js';
import type { NotificationSender } from '@brayz/carriers';
import { forTenant, prisma, writeAudit, Prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { buildNotifier, textGuest, textLocation } from '../lib/notifier.js';
import { announcesClosed, loadLocationSchedule } from '../lib/locationSchedule.js';
import { locationGuestMemoryMode } from '../lib/guests.js';
import { adjustPointsForOrder } from '../lib/loyalty.js';
import { decideSchedule } from '../lib/schedule.js';
import { spokenWhen } from '../lib/hours.js';
import { resolveOrCreateGuest } from '../lib/guests.js';
import {
  awardBonus,
  awardPointsForOrder,
  birthdayDedupeKey,
  birthdayWindowActive,
  isVip,
  locationLoyaltySettings,
  redeemRewardInTx,
  winbackEligible,
} from '../lib/loyalty.js';
import { requireNode } from '../auth/node.js';
import { requireTenant } from '../plugins/auth.js';
import { orderCode, toPosOrder } from '../lib/orderMapping.js';
import { requireEntitlement } from '../lib/billing.js';
import { guestFactsForCall } from './promotions.js';
import {
  isApplied,
  recordRedemptionInTx,
  resolvePromotion,
  type ResolvedPromotion,
} from '../lib/promotions.js';
import {
  defaultPosProviderFactory,
  pushOrderStatusToPos,
  pushOrderToPos,
  type PosProviderFactory,
} from '../lib/pos.js';

export interface OrderRouteOptions {
  /** Inject a sender (tests). `undefined` → build from config; `null` → notifications off. */
  notifier?: NotificationSender | null;
  /** Inject POS adapters (tests). Defaults to the real Square/manual factory. */
  posProviders?: PosProviderFactory;
  /** Places delivery addresses for the radius check. None: only ZIP rules can be judged. */
  geocoder?: GeocodingProvider | null;
}

/**
 * Pickup and delivery orders. The voice plane (Orchestrator, node-authed)
 * finalizes an order built during a call; the dashboard (user-authed,
 * tenant-scoped) reads them.
 *
 * Pricing is authoritative here, never from the LLM (CLAUDE.md rule #5): every
 * line is re-resolved from the call location's active menu by menuItemId, and the
 * total is computed from those prices — any client-supplied price is ignored.
 * The delivery fee, the minimum and the delivery area are the location's
 * settings, checked here whatever was said on the call.
 *
 * On confirm we text the restaurant (behind a provider-agnostic NotificationSender,
 * rule #2). Sending is best-effort: a failed text never fails the order, and the
 * attempt is recorded as a Notification for audit/idempotency.
 */
export async function orderRoutes(app: FastifyInstance, opts: OrderRouteOptions = {}): Promise<void> {
  const notifier = opts.notifier === undefined ? buildNotifier() : opts.notifier;
  const posProviders = opts.posProviders ?? defaultPosProviderFactory;
  const geocoder = opts.geocoder ?? null;

  // ---- Voice plane (node-authed): place a finalized order ----
  app.post('/v1/calls/:callId/order', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(CreateOrderInput, request.body);

    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { id: true, tenantId: true, locationId: true, guestId: true, fromNumber: true },
    });
    if (!call) throw notFound('Call');
    // Order taking is a Growth feature (pricing §10). Checked here, where the
    // order is actually created, rather than only in the UI that offers it.
    await requireEntitlement(call.locationId, 'orders');

    const { lines, subtotalCents } = await priceLines(call.locationId, input.items);

    // Pickup or delivery, as the location offers them. A delivery needs an
    // address inside the delivery area and an order that meets the minimum,
    // and the fee is the location's. All of it is decided here, where the order
    // is created, whatever was said on the call (rule #5) — the engine checks
    // the same things first only so the caller hears about them in time.
    const loc = await prisma.location.findUnique({
      where: { id: call.locationId },
      select: {
        ...DELIVERY_LOCATION_SELECT,
        pickupEnabled: true,
        deliveryEnabled: true,
        pickupEtaMinutes: true,
        deliveryEtaMinutes: true,
        deliveryFeeCents: true,
        deliveryMinimumCents: true,
      },
    });
    if (!loc) throw notFound('Location');
    // When the restaurant is shut and the owner asked for the closed
    // announcement, the only order that may be taken is one for a later time.
    // Checked here as well as in the engine because this is where an order
    // becomes real (rule #5) — a confused model must not be able to book a
    // kitchen that is dark.
    const now = new Date();
    const schedule = await loadLocationSchedule(call.locationId, now);
    let scheduledFor: Date | null = input.scheduledFor ? new Date(input.scheduledFor) : null;
    if (schedule && (scheduledFor || announcesClosed(schedule))) {
      const decision = decideSchedule(
        scheduledFor,
        now,
        schedule.tz,
        schedule.hours,
        schedule.holidays,
        schedule.policy,
      );
      if (!decision.ok) {
        const earliest = decision.earliest
          ? ` The earliest is ${spokenWhen(decision.earliest, now, schedule.tz)}.`
          : '';
        throw new HttpError(
          422,
          scheduledFor
            ? `That time cannot be ordered for (${decision.reason}).${earliest}`
            : `The restaurant is closed right now.${earliest}`,
          scheduledFor ? 'schedule_unavailable' : 'closed',
        );
      }
      scheduledFor = decision.at;
    }

    const delivery = input.fulfillmentType === 'delivery';
    let deliveryFeeCents = 0;
    let area: AreaResult | null = null;
    if (delivery) {
      if (!loc.deliveryEnabled) {
        throw new HttpError(422, 'This location does not deliver', 'delivery_unavailable');
      }
      if (!input.deliveryAddress) {
        throw new HttpError(422, 'A delivery order needs an address', 'delivery_address_required');
      }
      if (subtotalCents < loc.deliveryMinimumCents) {
        throw new HttpError(
          422,
          `Delivery orders start at $${(loc.deliveryMinimumCents / 100).toFixed(2)}`,
          'below_delivery_minimum',
        );
      }
      area = await checkDeliveryArea(loc, input.deliveryAddress, geocoder);
      app.log.info(
        {
          callId: call.id,
          locationId: call.locationId,
          check: area.check,
          deliverable: area.deliverable,
          distanceMiles: area.distanceMiles,
          zip: area.zip,
          matchedZip: area.matchedZip,
          zipMismatch: area.zipMismatch,
        },
        'delivery area checked for an order',
      );
      if (area.check === 'needs_zip') {
        throw new HttpError(422, 'The delivery address needs a ZIP code', 'delivery_zip_required');
      }
      if (!area.deliverable) {
        throw new HttpError(422, 'That address is outside the delivery area', 'outside_delivery_area');
      }
      deliveryFeeCents = loc.deliveryFeeCents;
    } else if (!loc.pickupEnabled) {
      throw new HttpError(422, 'This location does not offer pickup', 'pickup_unavailable');
    }
    // The address as the ticket keeps it — with the ZIP the lookup found, when
    // the caller did not say one.
    const deliveryAddress =
      delivery && input.deliveryAddress
        ? { ...input.deliveryAddress, postalCode: input.deliveryAddress.postalCode ?? area?.zip ?? undefined }
        : null;

    // Attach the order to a guest (records, always — independent of memory mode).
    // Reuse the call's guest if recognized; otherwise create-or-find one by the
    // caller's number and backfill the call so the rest of the call is linked too.
    let guestId = call.guestId ?? undefined;
    if (!guestId && call.fromNumber) {
      guestId = await resolveOrCreateGuest(call.tenantId, call.locationId, call.fromNumber, input.customerName);
      await prisma.call.update({ where: { id: call.id }, data: { guestId } }).catch(() => {});
    }

    // Loyalty redemption: validated here, never by the LLM (rule #5). The order
    // create and the point deduction commit atomically, and the balance guard in
    // redeemRewardInTx makes a concurrent double-spend impossible.
    const loyalty = await locationLoyaltySettings(call.locationId);
    let discountCents = 0;
    if (input.redeemReward) {
      if (!loyalty.enabled || !guestId) {
        throw new HttpError(422, 'Loyalty reward is not available', 'reward_unavailable');
      }
      const account = await prisma.loyaltyAccount.findUnique({
        where: { guestId },
        select: { pointsBalance: true },
      });
      if (!account || account.pointsBalance < loyalty.rewardPoints) {
        throw new HttpError(422, 'Not enough points for the reward', 'reward_unavailable');
      }
      discountCents = Math.min(loyalty.rewardCents, subtotalCents);
    }

    // Promotion, on top of any loyalty reward. Same rule as the reward: the API
    // decides whether it applies and what it is worth, never the LLM (rule #5),
    // and the two together can take the order to zero but never below it.
    let promotion: ResolvedPromotion | null = null;
    let promotionDiscountCents = 0;
    if (input.promotionId || input.promotionCode) {
      const facts = await guestFactsForCall(call.locationId, guestId ?? null);
      const resolved = await resolvePromotion(
        call.locationId,
        { promotionId: input.promotionId, promotionCode: input.promotionCode },
        facts,
        subtotalCents,
      );
      if (!resolved) throw new HttpError(422, 'That offer was not found', 'promotion_unavailable');
      if (!isApplied(resolved)) {
        throw new HttpError(422, resolved.reason, 'promotion_unavailable');
      }
      promotion = resolved;
      // Priced against what is left after the reward, so two discounts can
      // never sum past the order.
      promotionDiscountCents = Math.min(resolved.discountCents, subtotalCents - discountCents);
      discountCents += promotionDiscountCents;
    }

    const order = await prisma.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          tenantId: call.tenantId,
          locationId: call.locationId,
          callId: call.id,
          guestId,
          fulfillmentType: input.fulfillmentType,
          scheduledFor,
          status: 'confirmed',
          customerName: input.customerName,
          customerPhone: call.fromNumber ?? undefined,
          subtotalCents,
          // Tax is out of MVP scope. The total is the subtotal less the reward
          // and any promotion, plus the delivery fee — discounts come off the
          // food, never the fee.
          totalCents: subtotalCents - discountCents + deliveryFeeCents,
          discountCents,
          deliveryFeeCents,
          deliveryAddress: deliveryAddress ? addressJson(deliveryAddress) : undefined,
          deliveryAreaCheck: area?.check ?? null,
          notes: input.notes,
          items: {
            create: lines.map((l) => ({
              menuItemId: l.menuItemId,
              name: l.name,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              specialInstructions: l.specialInstructions,
              viaUpsell: l.viaUpsell,
              // The kitchen ticket's whole point: what the caller chose, as
              // rows, not as a sentence in a notes field.
              modifiers: l.modifiers.length ? { create: l.modifiers } : undefined,
            })),
          },
        },
        select: { id: true, totalCents: true },
      });
      if (promotion && promotionDiscountCents > 0) {
        // Inside the transaction: a promotion is never counted against its cap
        // for an order that failed to commit.
        await recordRedemptionInTx(tx, {
          tenantId: call.tenantId,
          promotionId: promotion.promotion.id,
          guestId,
          orderId: created.id,
          discountCents: promotionDiscountCents,
        });
      }
      if (discountCents - promotionDiscountCents > 0 && guestId) {
        await redeemRewardInTx(tx, {
          tenantId: call.tenantId,
          guestId,
          orderId: created.id,
          settings: loyalty,
        });
      }
      return created;
    });

    // Earn points on the confirmed total, plus any rule bonuses (VIP multiplier,
    // birthday, win-back). Best-effort and idempotent — a loyalty failure must
    // never fail the order.
    let pointsEarned = 0;
    let birthdayBonusPoints = 0;
    let winbackBonusPoints = 0;
    let vip = false;
    if (guestId && loyalty.enabled) {
      try {
        // VIP status and win-back lapse are judged on the world BEFORE this order.
        const [account, guest, lastOrder] = await Promise.all([
          prisma.loyaltyAccount.findUnique({
            where: { guestId },
            select: { lifetimeSpendCents: true },
          }),
          prisma.guest.findUnique({ where: { id: guestId }, select: { birthdayMonth: true } }),
          prisma.order.findFirst({
            where: { guestId, id: { not: order.id } },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true },
          }),
        ]);
        vip = isVip(account?.lifetimeSpendCents ?? 0, loyalty);

        const earn = await awardPointsForOrder({
          tenantId: call.tenantId,
          guestId,
          orderId: order.id,
          // Points are earned on the food, not the delivery fee.
          totalCents: order.totalCents - deliveryFeeCents,
          settings: loyalty,
          vip,
        });
        pointsEarned = earn.points;

        if (loyalty.birthdayEnabled && birthdayWindowActive(guest?.birthdayMonth)) {
          const given = await awardBonus({
            tenantId: call.tenantId,
            guestId,
            type: 'birthday',
            points: loyalty.birthdayBonusPoints,
            dedupeKey: birthdayDedupeKey(guestId),
            orderId: order.id,
            note: 'Birthday bonus',
          });
          if (given) birthdayBonusPoints = loyalty.birthdayBonusPoints;
        }

        if (winbackEligible(lastOrder?.createdAt, loyalty)) {
          const given = await awardBonus({
            tenantId: call.tenantId,
            guestId,
            type: 'winback',
            points: loyalty.winbackBonusPoints,
            dedupeKey: `loyalty-winback:${order.id}`,
            orderId: order.id,
            note: 'Welcome-back bonus',
          });
          if (given) winbackBonusPoints = loyalty.winbackBonusPoints;
        }
      } catch (err) {
        app.log.warn({ err, orderId: order.id }, 'loyalty earn failed');
      }
    }

    const code = orderCode(order.id);

    // Keep the address on the guest, so their next call can ask "are we still
    // delivering to…?". It is guest memory, so only while memory is on for
    // them. Best-effort: the order is placed either way.
    if (deliveryAddress && guestId) {
      await saveGuestDeliveryAddress({
        tenantId: call.tenantId,
        locationId: call.locationId,
        guestId,
        address: deliveryAddress,
      }).catch((err) => app.log.warn({ err, orderId: order.id }, 'saving the delivery address failed'));
    }

    // Text the restaurant. Best-effort: never fail the order on a notification error.
    if (notifier) {
      await notifyRestaurant(app, notifier, request, {
        tenantId: call.tenantId,
        locationId: call.locationId,
        orderId: order.id,
        orderCode: code,
        customerName: input.customerName,
        notes: input.notes,
        lines,
        totalCents: order.totalCents,
        scheduledFor: scheduledFor && schedule ? spokenWhen(scheduledFor, now, schedule.tz) : undefined,
        delivery: deliveryAddress
          ? {
              address: formatDeliveryAddress(deliveryAddress),
              instructions: deliveryAddress.instructions,
              unverified: area?.check === 'unverified',
            }
          : undefined,
      });
    }

    // Raise the ticket on the restaurant's POS. Like the SMS this is
    // best-effort and never fails the order (rule #3: Brayz is the record, the
    // POS is downstream) — a failure is recorded on the sync row and retryable
    // from the Orders screen.
    const pos = await pushOrderToPos(app.log, posProviders, {
      tenantId: call.tenantId,
      locationId: call.locationId,
      order: toPosOrder(
        {
          id: order.id,
          fulfillmentType: input.fulfillmentType,
          customerName: input.customerName ?? null,
          customerPhone: call.fromNumber ?? null,
          notes: [
            scheduledFor && schedule ? `FOR ${spokenWhen(scheduledFor, now, schedule.tz)}` : null,
            input.notes ?? null,
          ]
            .filter(Boolean)
            .join(' — ') || null,
          subtotalCents,
          deliveryFeeCents,
          deliveryAddress,
          totalCents: order.totalCents,
          items: lines.map((l) => ({
            name: l.name,
            quantity: l.quantity,
            unitPriceCents: l.unitPriceCents,
            specialInstructions: l.specialInstructions ?? null,
            // The portion travels in the name: a POS line has nowhere else to
            // put it, and "Pepperoni (left half)" is what the kitchen reads.
            modifiers: l.modifiers.map((m) => ({
              name: modifierLabel(m.name, m.portion),
              priceCents: m.priceCents,
            })),
          })),
        },
        code,
        { region: loc.region },
      ),
    });

    return reply.status(201).send({
      id: order.id,
      orderCode: code,
      totalCents: order.totalCents,
      discountCents,
      fulfillmentType: input.fulfillmentType,
      deliveryFeeCents,
      // What the bot quotes: "ready in about 20 minutes" / "with you in about 45".
      etaMinutes: delivery ? loc.deliveryEtaMinutes : loc.pickupEtaMinutes,
      // A scheduled order is quoted by its time instead — "ready at 6:15 PM"
      // — phrased here, where the timezone is known.
      scheduledFor: scheduledFor ? scheduledFor.toISOString() : null,
      scheduledSpoken: scheduledFor && schedule ? spokenWhen(scheduledFor, now, schedule.tz) : null,
      promotion: promotion
        ? {
            id: promotion.promotion.id,
            name: promotion.promotion.name,
            discountCents: promotionDiscountCents,
          }
        : null,
      posStatus: pos.status,
      pointsEarned,
      birthdayBonusPoints,
      winbackBonusPoints,
      vip,
    });
  });

  // ---- Dashboard (user-authed, tenant-scoped) ----
  // ---- Changing an order already placed -----------------------------------

  /**
   * "I just ordered — can I add a Coke?"
   *
   * The order a caller can still change is their own most recent one at this
   * location that the kitchen has not accepted yet. Status decides it, not the
   * clock: `confirmed` means the ticket is sitting there, anything past it
   * means somebody is already cooking, and a bot must not rewrite that.
   *
   * Rule #6 gates the read exactly as the saved address is gated. Full memory
   * mode trusts the caller-id match; confirm mode is told only that an order
   * exists and must hear the confirmation code back before any of it is given
   * out; memory off means no lookup at all. Every read that returns an order is
   * audited.
   */
  app.get('/v1/calls/:callId/order/recent', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const found = await recentChangeableOrder(callId);
    if ('miss' in found) return found.miss;
    const { call, order, mode } = found;
    if (mode === 'confirm' && !(await identityConfirmed(callId))) {
      // Nothing about the order — not its items, not its total. Only that there
      // is one, and what it will take to hear it.
      return { found: true, needsCode: true, attemptsLeft: await confirmAttemptsLeft(callId) };
    }
    await writeAudit({
      tenantId: call.tenantId,
      locationId: call.locationId,
      actorId: null,
      action: 'order.voice_lookup',
      targetType: 'order',
      targetId: order.id,
      metadata: { callId, mode },
    });
    return voiceOrder(order);
  });

  /**
   * Confirm mode: the caller reads back the code the bot gave them when they
   * ordered. Two wrong answers and the order is not offered again on this call
   * — the same posture, and the same call-event counter, as the saved address.
   */
  app.post('/v1/calls/:callId/order/recent/confirm', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const { code } = parse(z.object({ code: z.string().trim().min(1).max(24) }), request.body);
    const found = await recentChangeableOrder(callId);
    if ('miss' in found) return { confirmed: false, reason: 'no_order' };
    const { order } = found;
    const left = await confirmAttemptsLeft(callId);
    if (left <= 0) return { confirmed: false, reason: 'locked', attemptsLeft: 0 };
    // Said out loud and heard by a machine: "C 5 6 F B" and "c56fb" are the
    // same answer, and nothing but the letters and digits can be compared.
    const said = code.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (said !== orderCode(order.id)) {
      await prisma.callEvent.create({
        data: { callId, eventType: 'order.confirm_failed', payload: {} as Prisma.InputJsonValue },
      });
      return { confirmed: false, reason: 'mismatch', attemptsLeft: left - 1 };
    }
    await prisma.callEvent.create({
      data: { callId, eventType: 'order.identity_confirmed', payload: {} as Prisma.InputJsonValue },
    });
    await writeAudit({
      tenantId: found.call.tenantId,
      locationId: found.call.locationId,
      actorId: null,
      action: 'order.voice_lookup',
      targetType: 'order',
      targetId: order.id,
      metadata: { callId, mode: 'confirm' },
    });
    return { confirmed: true, ...voiceOrder(order) };
  });

  /**
   * The changed order. The items are the whole of it: what the caller is
   * changing is what they are having, and pickup-or-delivery, the address, the
   * name and any time it was booked for stay as they were placed. A caller who
   * wants those changed gets a message taken — rewriting where an order is
   * going is not something to do from a phone call the driver cannot see.
   *
   * Every line is re-priced from the menu, so an order changed on a second call
   * costs exactly what it would have on the first (rule #5). Any discount that
   * was granted is carried across rather than recomputed: it was given, and
   * taking it back because the caller added a drink would be a nasty surprise.
   */
  app.patch('/v1/calls/:callId/order/:orderId', async (request) => {
    requireNode(request);
    const { callId, orderId } = request.params as { callId: string; orderId: string };
    const input = parse(ChangeOrderInput, request.body);
    const found = await recentChangeableOrder(callId, orderId);
    if ('miss' in found) throw changeRefusal(found.miss);
    const { call, order, mode } = found;
    if (mode === 'confirm' && !(await identityConfirmed(callId))) {
      throw new HttpError(403, 'The caller has not confirmed the order', 'order_unconfirmed');
    }

    const { lines, subtotalCents } = await priceLines(call.locationId, input.items);
    const deliveryFeeCents = order.deliveryFeeCents;
    if (order.fulfillmentType === 'delivery') {
      const loc = await prisma.location.findUnique({
        where: { id: call.locationId },
        select: { deliveryMinimumCents: true },
      });
      // The minimum is about the food, and it still has to hold after a
      // removal — otherwise "take the pizza off" quietly leaves a delivery
      // below the floor the restaurant set.
      if (loc && subtotalCents < loc.deliveryMinimumCents) {
        throw new HttpError(
          422,
          `Delivery orders start at $${(loc.deliveryMinimumCents / 100).toFixed(2)}`,
          'below_delivery_minimum',
        );
      }
    }
    // What was taken off when it was placed — a loyalty reward, an offer — kept
    // whole, so changing the order never silently withdraws it. It comes off
    // the food and never the fee, as it did when the order was placed: a change
    // that takes the food under the discount makes the food free, not the
    // delivery. The grant itself stays on the order, so adding back restores it.
    const discountCents = Math.min(order.discountCents, subtotalCents);
    const totalCents = subtotalCents - discountCents + deliveryFeeCents;

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: {
          id: order.id,
          tenantId: call.tenantId,
          locationId: call.locationId,
          status: 'confirmed',
          revision: order.revision,
        },
        data: { revision: { increment: 1 } },
      });
      if (claimed.count === 0) {
        throw new HttpError(409, 'The order changed or was accepted by the kitchen', 'order_changed');
      }
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      return tx.order.update({
        where: { id: order.id, tenantId: call.tenantId },
        data: {
          subtotalCents,
          totalCents,
          items: {
            create: lines.map((l) => ({
              menuItemId: l.menuItemId,
              name: l.name,
              quantity: l.quantity,
              unitPriceCents: l.unitPriceCents,
              specialInstructions: l.specialInstructions,
              viaUpsell: l.viaUpsell,
              modifiers: l.modifiers.length ? { create: l.modifiers } : undefined,
            })),
          },
        },
        select: { id: true, totalCents: true, subtotalCents: true, revision: true },
      });
    });

    // Points follow the order. The ledger is append-only, so the difference is
    // its own entry rather than a rewrite of the earn — and keyed on the
    // revision this change made, so replaying it cannot double it and a later
    // change back to an earlier total still writes its own entry.
    if (order.guestId && totalCents !== order.totalCents) {
      const settings = await locationLoyaltySettings(call.locationId);
      await adjustPointsForOrder({
        tenantId: call.tenantId,
        guestId: order.guestId,
        orderId: order.id,
        fromCents: order.totalCents,
        toCents: totalCents,
        revision: updated.revision,
        settings,
      }).catch((err) => app.log.warn({ err, orderId: order.id }, 'loyalty adjust failed'));
    }

    const code = orderCode(order.id);
    await prisma.callEvent
      .create({
        data: {
          callId,
          eventType: 'order.changed',
          payload: { orderId: order.id, totalCents } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    await writeAudit({
      tenantId: call.tenantId,
      locationId: call.locationId,
      actorId: null,
      action: 'order.changed',
      targetType: 'order',
      targetId: order.id,
      metadata: { callId, fromCents: order.totalCents, toCents: totalCents },
    });
    if (notifier) {
      await notifyRestaurant(app, notifier, request, {
        tenantId: call.tenantId,
        locationId: call.locationId,
        orderId: order.id,
        orderCode: code,
        customerName: order.customerName ?? undefined,
        notes: order.notes ?? undefined,
        lines,
        totalCents,
        // Says what it is before it says anything else, and says the till needs
        // a human when the ticket has already been pushed to one.
        changed: {
          wasCents: order.totalCents,
          onPos: !!order.posSync,
          revision: updated.revision,
        },
        delivery: undefined,
      });
    }

    return {
      id: updated.id,
      orderCode: code,
      totalCents: updated.totalCents,
      subtotalCents: updated.subtotalCents,
      deliveryFeeCents,
      discountCents,
      posTicket: !!order.posSync,
    };
  });

  /** Cancel it outright, while the kitchen still has not taken it. */
  app.post('/v1/calls/:callId/order/:orderId/cancel', async (request) => {
    requireNode(request);
    const { callId, orderId } = request.params as { callId: string; orderId: string };
    const found = await recentChangeableOrder(callId, orderId);
    if ('miss' in found) throw changeRefusal(found.miss);
    const { call, order, mode } = found;
    if (mode === 'confirm' && !(await identityConfirmed(callId))) {
      throw new HttpError(403, 'The caller has not confirmed the order', 'order_unconfirmed');
    }
    const canceled = await prisma.order.updateMany({
      where: {
        id: order.id,
        tenantId: call.tenantId,
        locationId: call.locationId,
        status: 'confirmed',
        revision: order.revision,
      },
      data: { status: 'canceled', revision: { increment: 1 } },
    });
    if (canceled.count === 0) {
      throw new HttpError(409, 'The order changed or was accepted by the kitchen', 'order_changed');
    }
    // The till is told the same way the dashboard tells it.
    await pushOrderStatusToPos(app.log, posProviders, {
      locationId: call.locationId,
      orderId: order.id,
      status: 'canceled',
    });
    const code = orderCode(order.id);
    await prisma.callEvent
      .create({
        data: {
          callId,
          eventType: 'order.canceled',
          payload: { orderId: order.id } as Prisma.InputJsonValue,
        },
      })
      .catch(() => {});
    await writeAudit({
      tenantId: call.tenantId,
      locationId: call.locationId,
      actorId: null,
      action: 'order.canceled',
      targetType: 'order',
      targetId: order.id,
      metadata: { callId, totalCents: order.totalCents },
    });
    if (notifier) {
      await textLocation(app.log, notifier, {
        tenantId: call.tenantId,
        locationId: call.locationId,
        dedupeKey: `order-canceled:${order.id}`,
        body:
          `CANCELED — order #${code}${order.customerName ? ` for ${order.customerName}` : ''}, ` +
          `$${(order.totalCents / 100).toFixed(2)}. The caller canceled it by phone.` +
          (order.posSync ? ' Check the ticket on the till.' : ''),
        request,
      });
    }
    return { id: order.id, orderCode: code, status: 'canceled' };
  });

  /**
   * How many orders were taken in a range, every status. The dashboard's
   * "Orders today" used to count today's rows in the newest hundred orders of
   * all time, so past a hundred orders it undercounted, and on a day with more
   * than a hundred it could never be right.
   */
  app.get('/v1/locations/:locationId/orders/count', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(OrderCountQuery, request.query);
    const count = await forTenant(tenantId).order.count({
      where: { locationId, createdAt: { gte: q.from, lt: q.to } },
    });
    return { count };
  });

  /**
   * Orders for a location. `?status=open` is the working view — every order the
   * kitchen still has, with no cutoff, because "the newest hundred" hides an
   * old ticket that is still owed. `?status=closed` is completed and canceled,
   * newest first, keyset-paged on (createdAt, id) like the calls list, and
   * answers `{ orders, nextCursor }`. With no status it is the newest hundred
   * of everything, as it always was.
   */
  app.get('/v1/locations/:locationId/orders', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(ListOrdersQuery, request.query);
    const db = forTenant(tenantId);
    const include = {
      items: { orderBy: { name: 'asc' as const }, include: { modifiers: { orderBy: { name: 'asc' as const } } } },
      posSync: true,
    };
    const shape = (orders: Array<Prisma.OrderGetPayload<{ include: typeof include }>>) =>
      orders.map((o) => ({
        ...o,
        code: orderCode(o.id),
        // Surface the ticket's fate, never the vendor payload.
        pos: o.posSync
          ? {
              provider: o.posSync.provider,
              status: o.posSync.status,
              externalOrderId: o.posSync.externalOrderId,
              attempts: o.posSync.attempts,
              lastError: o.posSync.lastError,
            }
          : null,
        posSync: undefined,
      }));

    if (q.status === 'closed') {
      const limit = q.limit ?? 50;
      const page = await db.order.findMany({
        where: { locationId, status: { in: [...FINAL_ORDER_STATUSES] }, ...orderCursorWhere(q.cursor) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include,
      });
      const orders = page.slice(0, limit);
      const last = orders[orders.length - 1];
      return {
        orders: shape(orders),
        nextCursor: page.length > limit && last ? encodeOrderCursor(last) : null,
      };
    }

    const orders = await db.order.findMany({
      where: {
        locationId,
        ...(q.status === 'open' ? { status: { notIn: [...FINAL_ORDER_STATUSES] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      // Open orders are bounded by the kitchen, not by a page: every one is
      // shown. The ceiling only stops a location that never closes a ticket
      // from sending an unbounded response.
      take: q.status === 'open' ? 500 : 100,
      include,
    });
    return shape(orders);
  });

  /**
   * Move an order along (accept / ready / completed / canceled) and tell the POS.
   * Brayz's status is authoritative; the POS push is best-effort behind it.
   */
  app.patch('/v1/orders/:orderId', async (request) => {
    const tenantId = requireTenant(request);
    const { orderId } = request.params as { orderId: string };
    const input = parse(UpdateOrderStatusInput, request.body);
    const db = forTenant(tenantId);

    const existing = await db.order.findFirst({
      where: { id: orderId },
      select: { id: true, locationId: true, status: true, revision: true },
    });
    if (!existing) throw notFound('Order');
    if (existing.status === 'completed' || existing.status === 'canceled') {
      throw new HttpError(
        409,
        `Order is already ${existing.status}`,
        'order_status_final',
      );
    }

    const updated = await db.order.updateMany({
      where: { id: orderId, status: existing.status, revision: existing.revision },
      data: { status: input.status, revision: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new HttpError(409, 'The order changed; refresh before updating it', 'order_changed');
    }

    await pushOrderStatusToPos(app.log, posProviders, {
      locationId: existing.locationId,
      orderId: existing.id,
      status: input.status,
    });

    // Ready: text the guest, if they said yes on the call for this order and
    // the restaurant still texts guests. textGuest checks that consent (rule
    // #6) and is keyed on the order, so marking it ready twice sends once.
    if (input.status === 'ready' && notifier) {
      const detail = await db.order.findFirst({
        where: { id: orderId },
        select: {
          customerPhone: true,
          fulfillmentType: true,
          location: { select: { name: true, aiSettings: { select: { guestOrderTextsEnabled: true } } } },
        },
      });
      if (detail?.customerPhone && detail.location.aiSettings?.guestOrderTextsEnabled) {
        await textGuest(request.log, notifier, {
          tenantId,
          locationId: existing.locationId,
          phone: detail.customerPhone,
          orderId: existing.id,
          dedupeKey: `guest-order-ready:${existing.id}`,
          body: guestOrderReadySms(detail.location.name, orderCode(existing.id), detail.fulfillmentType === 'delivery'),
          request,
        });
      }
    }

    return { id: existing.id, status: input.status, code: orderCode(existing.id) };
  });
}

interface OrderNotice {
  tenantId: string;
  locationId: string;
  orderId: string;
  orderCode: string;
  customerName?: string;
  notes?: string;
  lines: Array<Pick<PricedLine, 'name' | 'quantity' | 'specialInstructions' | 'modifiers'>>;
  totalCents: number;
  /** Set when the caller ordered for later: the time, as it would be said. */
  scheduledFor?: string;
  /** Set when this is a change to an order already sent: what it was, and whether the till has it. */
  changed?: { wasCents: number; onPos: boolean; revision: number };
  /** Delivery orders: where it goes, and whether the area check could place it. */
  delivery?: { address: string; instructions?: string; unverified: boolean };
}

/**
 * Text the order to the restaurant (notification number, else main phone)
 * through the shared notifier — idempotent on the order id, from the
 * location's own line, and never failing the order (already saved).
 */
async function notifyRestaurant(
  app: FastifyInstance,
  notifier: NotificationSender,
  request: FastifyRequest,
  notice: OrderNotice,
): Promise<void> {
  const loc = await prisma.location
    .findUnique({ where: { id: notice.locationId }, select: { name: true } })
    .catch(() => null);
  await textLocation(app.log, notifier, {
    tenantId: notice.tenantId,
    locationId: notice.locationId,
    // A change is its own text, keyed on the revision it made, so the same
    // change never sends twice and a second change still gets through — even
    // one that happens to come to the same total.
    dedupeKey: notice.changed
      ? `order-changed:${notice.orderId}:${notice.changed.revision}`
      : `order-confirmed:${notice.orderId}`,
    body: buildOrderSms({ restaurantName: loc?.name ?? undefined, ...notice }),
    request,
  });
}

export function buildOrderSms(o: {
  restaurantName?: string;
  orderCode: string;
  customerName?: string;
  notes?: string;
  lines: OrderNotice['lines'];
  totalCents: number;
  scheduledFor?: string;
  changed?: OrderNotice['changed'];
  delivery?: OrderNotice['delivery'];
}): string {
  const items = o.lines
    .map((line) => {
      const options = line.modifiers.map((modifier) => modifierLabel(modifier.name, modifier.portion));
      if (line.specialInstructions) options.push(line.specialInstructions);
      return `${line.quantity}x ${line.name}${options.length ? ` (${options.join('; ')})` : ''}`;
    })
    .join(', ');
  const who = o.customerName ? ` for ${o.customerName}` : '';
  const total = `$${(o.totalCents / 100).toFixed(2)}`;
  const tail = `${o.notes ? ` Notes: ${o.notes}.` : ''}${o.restaurantName ? ` — ${o.restaurantName}` : ''}`;
  // The time leads, in capitals: a call-ahead read as a live ticket is a pizza
  // sitting under a lamp for three hours, or made three hours too late.
  const when = o.scheduledFor ? `FOR ${o.scheduledFor.toUpperCase()} — ` : '';
  // A change has to read as a change in the first two words, or it is read as
  // a second order and the kitchen makes both.
  if (o.changed) {
    const was = `$${(o.changed.wasCents / 100).toFixed(2)}`;
    const till = o.changed.onPos ? ' Amend the ticket on the till.' : '';
    return (
      `CHANGED — order #${o.orderCode}${who} is now: ${items}. Total ${total} (was ${was}).` +
      `${till}${tail}`
    );
  }
  if (!o.delivery) return `${when}New pickup order #${o.orderCode}${who}: ${items}. Total ${total}.${tail}`;
  const note = o.delivery.instructions ? ` (${o.delivery.instructions})` : '';
  // Taken rather than refused when the lookup failed — so the text says so.
  const flag = o.delivery.unverified ? ' Address not checked against the delivery area.' : '';
  return (
    `${when}New delivery order #${o.orderCode}${who}: ${items}. Deliver to ${o.delivery.address}${note}. ` +
    `Total ${total}.${flag}${tail}`
  );
}

/** One priced line, as both the create and the amend build it. */
export type PricedLine = {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  specialInstructions?: string;
  modifiers: Array<{ modifierId: string; name: string; priceCents: number; portion: 'whole' | 'left' | 'right' }>;
  viaUpsell: boolean;
};

/**
 * Price a set of requested lines from the location's live menu.
 *
 * Every price, name and option comes from the menu by id — what the caller
 * sent is a request, never a price (rule #5). Shared by placing an order and
 * by changing one, so a caller who adds a garlic bread on a second call is
 * charged exactly what they would have been on the first.
 */
async function priceLines(
  locationId: string,
  items: z.input<typeof CreateOrderInput>['items'],
): Promise<{ lines: PricedLine[]; subtotalCents: number }> {
  // Re-resolve each line from the location's active menu by id (authoritative).
  const ids = items.map((i) => i.menuItemId).filter((x): x is string => !!x);
  const menuItems = ids.length
    ? await prisma.menuItem.findMany({
        where: {
          id: { in: ids },
          available: true,
          category: { menu: { locationId: locationId, active: true } },
        },
        select: {
          id: true,
          name: true,
          priceCents: true,
          // Resolved here rather than trusted from the caller: an option's
          // name and price come from the menu, and only options belonging to
          // this item can be chosen (rule #5).
          modifierGroups: {
            select: {
              name: true,
              required: true,
              minSelections: true,
              maxSelections: true,
              allowsHalves: true,
              halfPricing: true,
              modifiers: { select: { id: true, name: true, priceCents: true, available: true } },
            },
          },
        },
      })
    : [];
  const byId = new Map(menuItems.map((m) => [m.id, m]));

  const lines = items.map((i) => {
    const m = i.menuItemId ? byId.get(i.menuItemId) : undefined;
    if (!m) throw new HttpError(422, `Item not available: ${i.name}`, 'item_unavailable');
    const options = new Map(
      m.modifierGroups.flatMap((g) =>
        g.modifiers.filter((o) => o.available).map((o) => [o.id, { ...o, group: g }] as const),
      ),
    );
    const selections = [
      ...(i.modifierIds ?? []).map((id) => ({ id, portion: 'whole' as const })),
      ...(i.modifiers ?? []),
    ];
    const modifiers = selections.map(({ id, portion = 'whole' }) => {
      const o = options.get(id);
      // An option this item does not have (or one the restaurant has turned
      // off) fails the order rather than quietly dropping off the ticket:
      // the caller asked for it, and the kitchen would never know.
      if (!o) throw new HttpError(422, `Option not available for ${m.name}`, 'modifier_unavailable');
      // A half of something the menu says is one thing is the same kind of
      // error: the kitchen cannot make it, so the order must not claim it.
      if (portion !== 'whole' && !o.group.allowsHalves) {
        throw new HttpError(422, `${m.name} cannot be made half-and-half`, 'half_not_allowed');
      }
      return {
        modifierId: o.id,
        name: o.name,
        // Priced for the portion here, once, so every reader of the row —
        // the ticket, the POS, the dashboard — sees the same number.
        priceCents: portionPriceCents(o.priceCents, portion, o.group.halfPricing),
        portion,
      };
    });
    for (const group of m.modifierGroups) checkGroupChoices(m.name, group, modifiers);
    return {
      menuItemId: m.id,
      name: m.name,
      quantity: i.quantity ?? 1,
      unitPriceCents: m.priceCents,
      specialInstructions: i.specialInstructions,
      modifiers,
      // Attribution only — it never touches the price, which still comes from
      // the menu above.
      viaUpsell: i.viaUpsell === true,
    };
  });
  // Options are priced per unit of the line: two pizzas with extra cheese are
  // two lots of extra cheese.
  const subtotalCents = lines.reduce(
    (sum, l) =>
      sum + (l.unitPriceCents + l.modifiers.reduce((c, o) => c + o.priceCents, 0)) * l.quantity,
    0,
  );
  return { lines, subtotalCents };
}

/**
 * Hold a line to its option groups' rules: a required choice made, and no more
 * picked than the group allows. The engine asks for these on the call, but the
 * order is what the kitchen works from, so the API enforces them too (rule #5)
 * — a wing with no sauce is not an order the kitchen can make.
 *
 * A half-and-half is two sides of one item, each held to the rule on its own:
 * "half pepperoni, half sausage" is one topping a side, not two on the pie. A
 * group whose options are all switched off asks nothing — the caller cannot
 * choose what the restaurant has taken away.
 */
function checkGroupChoices(
  itemName: string,
  group: {
    name: string;
    required: boolean;
    minSelections: number;
    maxSelections: number | null;
    modifiers: Array<{ id: string; available: boolean }>;
  },
  chosen: Array<{ modifierId: string; portion: 'whole' | 'left' | 'right' }>,
): void {
  if (!group.modifiers.some((o) => o.available)) return;
  const ids = new Set(group.modifiers.map((o) => o.id));
  const inGroup = chosen.filter((c) => ids.has(c.modifierId));
  const sides = inGroup.some((c) => c.portion !== 'whole')
    ? (['left', 'right'] as const).map((side) =>
        inGroup.filter((c) => c.portion === 'whole' || c.portion === side),
      )
    : [inGroup];
  const min = Math.max(group.required ? 1 : 0, group.minSelections);
  const max = group.maxSelections;
  for (const side of sides) {
    const count = new Set(side.map((c) => c.modifierId)).size;
    if (count < min) {
      const needs = min === 1 ? `a ${group.name} choice` : `at least ${min} ${group.name} choices`;
      throw new HttpError(422, `${itemName} needs ${needs}`, 'modifier_required');
    }
    if (max != null && count > max) {
      const most = `${max} ${group.name} choice${max === 1 ? '' : 's'}`;
      throw new HttpError(422, `${itemName} takes at most ${most}`, 'modifier_limit');
    }
  }
}

/** Wrong codes a caller may give before the order stops being offered on this call. */
const ORDER_CONFIRM_ATTEMPTS = 2;

/** Everything the voice plane is told about an order it may change. */
function voiceOrder(order: ChangeableOrder): Record<string, unknown> {
  return {
    found: true,
    needsCode: false,
    orderId: order.id,
    orderCode: orderCode(order.id),
    placedAt: order.createdAt.toISOString(),
    fulfillmentType: order.fulfillmentType,
    scheduledFor: order.scheduledFor ? order.scheduledFor.toISOString() : null,
    customerName: order.customerName,
    subtotalCents: order.subtotalCents,
    deliveryFeeCents: order.deliveryFeeCents,
    totalCents: order.totalCents,
    // Enough to rebuild the order as a draft the caller can add to and take
    // from: ids, not just names, so every line re-prices from the menu.
    items: order.items.map((i) => ({
      menuItemId: i.menuItemId,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      specialInstructions: i.specialInstructions,
      modifiers: i.modifiers.map((m) => ({
        modifierId: m.modifierId,
        name: m.name,
        priceCents: m.priceCents,
        portion: m.portion,
      })),
    })),
    // The till already has it, so a change needs a person there as well.
    posTicket: !!order.posSync,
  };
}

type ChangeableOrder = Prisma.OrderGetPayload<{
  include: { items: { include: { modifiers: true } }; posSync: true };
}>;

/**
 * The caller's own most recent order at this location that can still be
 * changed, with the memory mode that governs telling them about it.
 *
 * "Can still be changed" is `confirmed` and nothing further: once the kitchen
 * has accepted it somebody is cooking, and the answer a caller needs then is a
 * person, not a bot quietly rewriting the ticket.
 */
async function recentChangeableOrder(
  callId: string,
  orderId?: string,
): Promise<
  | { miss: { found: false; reason: string; status?: string } }
  | { call: { tenantId: string; locationId: string }; order: ChangeableOrder; mode: string }
> {
  const call = await prisma.call.findUnique({
    where: { id: callId },
    select: { tenantId: true, locationId: true, guestId: true, fromNumber: true },
  });
  if (!call) return { miss: { found: false, reason: 'no_call' } };
  const mode = await locationGuestMemoryMode(call.locationId);
  if (mode === 'off') return { miss: { found: false, reason: 'memory_off' } };

  // The guest this call belongs to. Recognized callers already have one; for
  // anyone else the number is looked up but never created — there is nothing to
  // find for a guest who has never ordered.
  let guestId = call.guestId;
  if (!guestId && call.fromNumber) {
    const byPhone = await prisma.guestPhoneNumber.findFirst({
      where: { tenantId: call.tenantId, e164: call.fromNumber },
      select: { guestId: true },
    });
    guestId = byPhone?.guestId ?? null;
  }
  if (!guestId) return { miss: { found: false, reason: 'unknown_caller' } };

  const order = await prisma.order.findFirst({
    where: {
      ...(orderId ? { id: orderId } : {}),
      tenantId: call.tenantId,
      locationId: call.locationId,
      guestId,
    },
    orderBy: { createdAt: 'desc' },
    include: { items: { include: { modifiers: true } }, posSync: true },
  });
  if (!order) return { miss: { found: false, reason: 'none' } };
  // Found, but past changing: say which, so the caller is told what is true
  // ("it's already with the kitchen") rather than "I can't find it".
  if (order.status !== 'confirmed') {
    return { miss: { found: false, reason: 'locked', status: order.status } };
  }
  return { call: { tenantId: call.tenantId, locationId: call.locationId }, order, mode };
}

/**
 * Why an order a node asked to change or cancel cannot be. Already with the
 * kitchen is its own answer (409 `order_locked`, with the status), so the
 * caller hears "it's already being made" rather than "I can't find it".
 */
function changeRefusal(miss: { reason: string; status?: string }): HttpError {
  if (miss.reason === 'locked') {
    return new HttpError(409, `The order is already ${miss.status}`, 'order_locked', {
      status: miss.status,
    });
  }
  return notFound('Order');
}

/** Has the caller read the code back on this call? Confirm mode only. */
async function identityConfirmed(callId: string): Promise<boolean> {
  const seen = await prisma.callEvent.count({
    where: { callId, eventType: 'order.identity_confirmed' },
  });
  return seen > 0;
}

async function confirmAttemptsLeft(callId: string): Promise<number> {
  const misses = await prisma.callEvent.count({
    where: { callId, eventType: 'order.confirm_failed' },
  });
  return Math.max(0, ORDER_CONFIRM_ATTEMPTS - misses);
}

// ---- Orders list helpers ----

/** An order the kitchen is finished with, one way or the other. */
const FINAL_ORDER_STATUSES = ['completed', 'canceled'] as const;

/** Rows strictly after the cursor in (createdAt desc, id desc) order. */
function orderCursorWhere(cursor?: string) {
  if (!cursor) return {};
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = iso ? new Date(iso) : new Date(NaN);
  if (!id || Number.isNaN(createdAt.getTime())) throw new HttpError(400, 'Bad cursor', 'bad_cursor');
  return { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] };
}

function encodeOrderCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}
