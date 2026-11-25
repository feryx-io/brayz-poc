import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CALL_HISTOGRAM_MAX_BUCKETS, InsightsQuery } from '@brayz/shared';
import { forTenant, prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant } from '../plugins/auth.js';
import { isKnownTimeZone } from '../lib/timezone.js';
import {
  BUCKET_MS,
  callsThatWouldHaveRungOut,
  groupOptions,
  toNumber,
  type OptionGroup,
  type HolidayInterval,
  type OpenInterval,
} from '../lib/insights.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What Brayz did for one restaurant over a window — the answer to "what am I
 * paying for?", which the dashboard's live counters never gave.
 *
 * Tenant-scoped like every other location read (rule #1): the tenant and the
 * location are in every WHERE, including the raw ones. Read-only and about the
 * restaurant's own trade, so it is not role-gated beyond membership — the same
 * posture as loyalty-stats, which it now shares its upsell maths with.
 */
export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/locations/:locationId/insights', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(InsightsQuery, request.query);
    const bucket = q.bucket ?? 'day';
    const top = q.top ?? 5;

    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true, timezone: true },
    });
    if (!location) throw notFound('Location');
    // The restaurant's own timezone is the sensible default: its trading day is
    // what the numbers are about, not the browser's.
    const tz = q.tz && q.tz !== 'UTC' ? q.tz : (location.timezone ?? 'UTC');
    if (!isKnownTimeZone(tz)) throw new HttpError(400, `Unknown timezone: ${tz}`, 'bad_timezone');

    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new HttpError(400, '`from` must be before `to`', 'bad_range');
    const buckets = Math.ceil((to.getTime() - from.getTime()) / BUCKET_MS[bucket]) + 1;
    if (buckets > CALL_HISTOGRAM_MAX_BUCKETS) {
      throw new HttpError(
        400,
        `That range is more than ${CALL_HISTOGRAM_MAX_BUCKETS} ${bucket}s — pick a larger bucket`,
        'too_many_buckets',
      );
    }

    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const step = `1 ${bucket}`;
    const inWindow = { gte: from, lt: to };
    const orderWhere = { tenantId, locationId, status: { not: 'canceled' }, createdAt: inWindow };

    const [series, orderTotals, byFulfillment, upsellLines, loyaltyEvents, topItems, itemOptions, topGuestRows, callRows, hours, holidays, guestSplit] =
      await Promise.all([
        // Gap-free per bucket, cut in the restaurant's timezone. Raw SQL for
        // generate_series and date_trunc-in-a-timezone, neither of which Prisma
        // can express; every value is a bound parameter.
        prisma.$queryRaw<Array<{ start: string; calls: bigint; orders: bigint; revenue: bigint }>>`
          WITH series AS (
            SELECT generate_series(
              date_trunc(${bucket}, ${fromIso}::timestamptz AT TIME ZONE ${tz}),
              date_trunc(${bucket}, (${toIso}::timestamptz - interval '1 millisecond') AT TIME ZONE ${tz}),
              ${step}::interval
            ) AS bucket
          ),
          call_counts AS (
            SELECT date_trunc(${bucket}, ("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
                   COUNT(*) AS calls
            FROM calls
            WHERE "tenantId" = ${tenantId}::uuid
              AND "locationId" = ${locationId}::uuid
              AND "startedAt" >= (${fromIso}::timestamptz AT TIME ZONE 'UTC')
              AND "startedAt" <  (${toIso}::timestamptz AT TIME ZONE 'UTC')
            GROUP BY 1
          ),
          order_counts AS (
            SELECT date_trunc(${bucket}, ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
                   COUNT(*) AS orders,
                   COALESCE(SUM("totalCents"), 0) AS revenue
            FROM orders
            WHERE "tenantId" = ${tenantId}::uuid
              AND "locationId" = ${locationId}::uuid
              AND status <> 'canceled'
              AND "createdAt" >= (${fromIso}::timestamptz AT TIME ZONE 'UTC')
              AND "createdAt" <  (${toIso}::timestamptz AT TIME ZONE 'UTC')
            GROUP BY 1
          )
          SELECT to_char(s.bucket, 'YYYY-MM-DD"T"HH24:MI') AS start,
                 COALESCE(c.calls, 0)    AS calls,
                 COALESCE(o.orders, 0)   AS orders,
                 COALESCE(o.revenue, 0)  AS revenue
          FROM series s
          LEFT JOIN call_counts  c ON c.bucket = s.bucket
          LEFT JOIN order_counts o ON o.bucket = s.bucket
          ORDER BY s.bucket
        `,
        prisma.order.aggregate({
          where: orderWhere,
          _count: { _all: true },
          _sum: { totalCents: true, subtotalCents: true, deliveryFeeCents: true },
        }),
        prisma.order.groupBy({
          by: ['fulfillmentType'],
          where: orderWhere,
          _count: { _all: true },
          _sum: { totalCents: true },
        }),
        // What the bot's own suggestions brought in, priced from the stored
        // line rather than recomputed, so it matches what the guest was charged.
        prisma.orderItem.findMany({
          where: { viaUpsell: true, order: orderWhere },
          select: { quantity: true, unitPriceCents: true },
        }),
        prisma.loyaltyEvent.groupBy({
          by: ['type'],
          where: { tenantId, account: { guest: { locationId } }, createdAt: inWindow },
          _sum: { points: true },
          _count: { _all: true },
        }),
        prisma.orderItem.groupBy({
          by: ['name'],
          where: { order: orderWhere },
          _sum: { quantity: true },
          orderBy: { _sum: { quantity: 'desc' } },
          take: top,
        }),
        // What was chosen on those items — the sauce on the wings, the toppings
        // on the pizza. Summed on the line's quantity, so two wings with
        // Buffalo Mild are two of them, not one. Halves fold into their option:
        // "Pepperoni" on half a pizza is still pepperoni being ordered, and
        // splitting it in two would bury the count it belongs to.
        //
        // Kept apart by the group they came from. The order row stores an
        // option's name, not its group, so it is resolved back through the menu:
        // a sauce and a dip listed together read as one list of flavours, which
        // is what the first version did and what it was wrong about. An option
        // with no group — recorded ad hoc when the menu could not price it, or
        // whose menu row has since gone — is kept and called "Other" rather
        // than dropped or filed under a group it never belonged to.
        prisma.$queryRaw<Array<{ item: string; group_name: string | null; option: string; quantity: bigint }>>`
          SELECT i.name AS item, g.name AS group_name, m.name AS option, SUM(i.quantity) AS quantity
          FROM order_items i
          JOIN orders o ON o.id = i."orderId"
          JOIN order_item_modifiers m ON m."orderItemId" = i.id
          LEFT JOIN menu_modifiers mm ON mm.id = m."modifierId"
          LEFT JOIN menu_modifier_groups g ON g.id = mm."modifierGroupId"
          WHERE o."tenantId" = ${tenantId}::uuid
            AND o."locationId" = ${locationId}::uuid
            AND o.status <> 'canceled'
            AND o."createdAt" >= ${from}
            AND o."createdAt" <  ${to}
          GROUP BY 1, 2, 3
          ORDER BY 4 DESC
        `,
        prisma.order.groupBy({
          by: ['guestId'],
          where: { ...orderWhere, guestId: { not: null } },
          _count: { _all: true },
          _sum: { totalCents: true },
          orderBy: { _sum: { totalCents: 'desc' } },
          take: top,
        }),
        // The rung-out count is arithmetic over the window's calls, which is
        // hundreds of rows at most — clearer in code than in SQL.
        prisma.call.findMany({
          where: { tenantId, locationId, startedAt: inWindow },
          select: { startedAt: true, endedAt: true },
        }),
        prisma.locationHours.findMany({
          where: { locationId },
          select: { dayOfWeek: true, opensAt: true, closesAt: true },
        }),
        prisma.locationHolidayHours.findMany({
          where: { locationId, date: { gte: new Date(from.getTime() - DAY_MS), lt: new Date(to.getTime() + DAY_MS) } },
          select: { date: true, closed: true, opensAt: true, closesAt: true },
        }),
        // Returning means the guest has ordered here more than once — the
        // second visit is the whole point, and it counts whether the first one
        // was last year or earlier in this same window. Measuring it against
        // the window's start instead said "0 returning" for a restaurant whose
        // regular had ordered thirty-five times, simply because all thirty-five
        // were inside the period being read.
        prisma.$queryRaw<Array<{ guests: bigint; returning: bigint }>>`
          WITH ordering AS (
            SELECT DISTINCT "guestId"
            FROM orders
            WHERE "tenantId" = ${tenantId}::uuid
              AND "locationId" = ${locationId}::uuid
              AND status <> 'canceled'
              AND "guestId" IS NOT NULL
              AND "createdAt" >= ${from}
              AND "createdAt" <  ${to}
          )
          SELECT COUNT(*) AS guests,
                 -- Bounded at the window's end, so a report of last month does
                 -- not change its split when the guest orders again today.
                 COUNT(*) FILTER (WHERE (
                   SELECT COUNT(*) FROM orders e
                   WHERE e."guestId" = ordering."guestId"
                     AND e."tenantId" = ${tenantId}::uuid
                     AND e."locationId" = ${locationId}::uuid
                     AND e.status <> 'canceled'
                     AND e."createdAt" < ${to}
                 ) > 1) AS returning
          FROM ordering
        `,
      ]);

    const guestIds = topGuestRows.map((r) => r.guestId).filter((id): id is string => !!id);
    const guests = guestIds.length
      ? await prisma.guest.findMany({
          where: { id: { in: guestIds }, tenantId },
          select: { id: true, displayName: true, loyalty: { select: { lifetimeSpendCents: true } } },
        })
      : [];
    const nameOf = new Map(guests.map((g) => [g.id, g]));

    const byType = Object.fromEntries(
      loyaltyEvents.map((r) => [r.type, { points: r._sum.points ?? 0, count: r._count._all }]),
    ) as Record<string, { points: number; count: number }>;
    const orders = orderTotals._count._all;
    const revenueCents = orderTotals._sum.totalCents ?? 0;
    const rungOut = callsThatWouldHaveRungOut(
      callRows,
      tz,
      hours as OpenInterval[],
      holidays.map(
        (h): HolidayInterval => ({
          date: h.date.toISOString().slice(0, 10),
          closed: h.closed,
          opensAt: h.opensAt,
          closesAt: h.closesAt,
        }),
      ),
    );

    return {
      window: { from: from.toISOString(), to: to.toISOString(), tz, bucket },
      calls: {
        answered: callRows.length,
        // Named for what it is: the calls that would have gone unanswered.
        wouldHaveRungOut: rungOut.total,
        afterHours: rungOut.afterHours,
        whileAnotherCallWasLive: rungOut.whileBusy,
        // Hours are what makes "after hours" meaningful; without them it is 0.
        hoursKnown: hours.length > 0,
      },
      orders: {
        count: orders,
        revenueCents,
        averageCents: orders ? Math.round(revenueCents / orders) : 0,
        deliveryFeeCents: orderTotals._sum.deliveryFeeCents ?? 0,
        byFulfillment: byFulfillment.map((r) => ({
          type: r.fulfillmentType,
          count: r._count._all,
          revenueCents: r._sum.totalCents ?? 0,
        })),
        // Rewards and offers, as the gap between what was ordered and what was charged.
        discountCents: Math.max(
          0,
          (orderTotals._sum.subtotalCents ?? 0) +
            (orderTotals._sum.deliveryFeeCents ?? 0) -
            revenueCents,
        ),
      },
      upsell: {
        items: upsellLines.length,
        revenueCents: upsellLines.reduce((sum, l) => sum + l.quantity * l.unitPriceCents, 0),
      },
      loyalty: {
        pointsEarned: byType.earn?.points ?? 0,
        redemptions: byType.redeem?.count ?? 0,
        pointsRedeemed: Math.abs(byType.redeem?.points ?? 0),
        birthdayBonuses: byType.birthday?.count ?? 0,
        winbackBonuses: byType.winback?.count ?? 0,
      },
      guests: {
        ordering: toNumber(guestSplit[0]?.guests ?? 0),
        returning: toNumber(guestSplit[0]?.returning ?? 0),
        new: toNumber(guestSplit[0]?.guests ?? 0) - toNumber(guestSplit[0]?.returning ?? 0),
        top: topGuestRows.map((r) => ({
          id: r.guestId,
          name: nameOf.get(r.guestId ?? '')?.displayName ?? null,
          orders: r._count._all,
          spentCents: r._sum.totalCents ?? 0,
          lifetimeSpendCents: nameOf.get(r.guestId ?? '')?.loyalty?.lifetimeSpendCents ?? 0,
        })),
      },
      items: topItems.map((r) => ({
        name: r.name,
        quantity: r._sum.quantity ?? 0,
        // The options chosen on it, kept apart by the group they came from and
        // biggest first within each. Capped both ways: a pizza with
        // twenty-seven toppings would otherwise bury the item it belongs to,
        // and the interesting case — which sauce the wings went out with, and
        // which dip beside it — is answered by the first few of each.
        optionGroups: groupOptions(itemOptions.filter((o) => o.item === r.name)),
      })),
      series: series.map((r) => ({
        start: r.start,
        calls: toNumber(r.calls),
        orders: toNumber(r.orders),
        revenueCents: toNumber(r.revenue),
      })),
    };
  });

  /**
   * Every item on the menu and how much of it went out — including the ones
   * that went out none.
   *
   * The favourites list on the overview answers "what sells"; this answers the
   * question a restaurant actually acts on, which is "what does not". That is
   * why it is built from the **menu** and sales are joined onto it: an item
   * nobody ordered has no order rows to be found in, so counting from orders
   * can never show it, however the counting is done.
   *
   * `lastOrderedAt` reaches outside the window on purpose. "0 this month" and
   * "nobody has ordered it since June" are different facts, and the second is
   * the one that decides whether an item comes off the menu.
   */
  app.get('/v1/locations/:locationId/insights/items', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(InsightsQuery, request.query);

    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true, timezone: true },
    });
    if (!location) throw notFound('Location');
    const tz = q.tz && q.tz !== 'UTC' ? q.tz : (location.timezone ?? 'UTC');
    if (!isKnownTimeZone(tz)) throw new HttpError(400, `Unknown timezone: ${tz}`, 'bad_timezone');
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new HttpError(400, '`from` must be before `to`', 'bad_range');

    const { items, offMenu } = await menuItemSales(tenantId, locationId, from, to);

    return {
      window: { from: from.toISOString(), to: to.toISOString(), tz },
      items,
      offMenu,
      totals: {
        onMenu: items.length,
        // The two facts worth leading with: what earned nothing this window,
        // and what has never earned anything at all.
        unsoldInWindow: items.filter((i) => i.quantity === 0).length,
        neverOrdered: items.filter((i) => i.lastOrderedAt === null).length,
        quantity: items.reduce((sum, i) => sum + i.quantity, 0),
        revenueCents: items.reduce((sum, i) => sum + i.revenueCents, 0),
      },
    };
  });

  /**
   * The same two tables as a spreadsheet: one row per menu item, and one row
   * per option chosen on it. Two files rather than one, because they count
   * different things — an item's quantity and a topping's quantity summed in
   * the same column would be nonsense in a pivot table.
   *
   * Same access as the screen it comes from: this is the restaurant's own
   * trade, with no guest in it.
   */
  app.get('/v1/locations/:locationId/insights/items.csv', async (request, reply) => {
    const { items, offMenu, location, window } = await exportContext(request);
    const rows = [
      ['category', 'item', 'menu_price', 'on_menu', 'available', 'quantity', 'order_lines', 'revenue', 'last_ordered'],
      ...items.map((i) => [
        i.category,
        i.name,
        money(i.priceCents),
        'yes',
        i.available ? 'yes' : 'no',
        i.quantity,
        i.orderLines,
        money(i.revenueCents),
        i.lastOrderedAt ? i.lastOrderedAt.slice(0, 10) : '',
      ]),
      // Sold, but no longer on the menu. Last, and marked — the money was taken
      // either way, and a spreadsheet that omits it does not add up.
      ...offMenu.map((i) => ['', i.name, '', 'no', '', i.quantity, i.orderLines, money(i.revenueCents), '']),
    ];
    return sendCsv(reply, `menu-items-${slug(location.name)}-${window}`, rows);
  });

  app.get('/v1/locations/:locationId/insights/item-options.csv', async (request, reply) => {
    const { items, location, window } = await exportContext(request);
    const rows = [
      ['category', 'item', 'option_group', 'option', 'quantity', 'share_of_item'],
      ...items.flatMap((i) =>
        i.optionGroups.flatMap((g) =>
          g.options.map((o) => [
            i.category,
            i.name,
            g.name,
            o.name,
            o.quantity,
            // How often this option came with the item, which is the number a
            // restaurant orders stock against: 34 pizzas, 20 of them pepperoni.
            i.quantity ? `${Math.round((o.quantity / i.quantity) * 100)}%` : '',
          ]),
        ),
      ),
    ];
    return sendCsv(reply, `menu-options-${slug(location.name)}-${window}`, rows);
  });

  /** The window, the location and the figures both exports are built from. */
  async function exportContext(request: FastifyRequest): Promise<{
    items: Awaited<ReturnType<typeof menuItemSales>>['items'];
    offMenu: Awaited<ReturnType<typeof menuItemSales>>['offMenu'];
    location: { name: string };
    window: string;
  }> {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(InsightsQuery, request.query);
    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true, name: true },
    });
    if (!location) throw notFound('Location');
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new HttpError(400, '`from` must be before `to`', 'bad_range');
    const { items, offMenu } = await menuItemSales(tenantId, location.id, from, to);
    return {
      items,
      offMenu,
      location,
      window: `${from.toISOString().slice(0, 10)}_${to.toISOString().slice(0, 10)}`,
    };
  }
}

/**
 * Every item on the menu with what it sold in the window, the options chosen
 * on it, and the lines whose item is no longer on the menu.
 *
 * Shared by the screen and its export, so a spreadsheet and the page can never
 * disagree about what was sold.
 */
async function menuItemSales(
  tenantId: string,
  locationId: string,
  from: Date,
  to: Date,
): Promise<{
  items: Array<{
    menuItemId: string;
    name: string;
    category: string;
    categoryOrder: number;
    priceCents: number;
    available: boolean;
    quantity: number;
    orderLines: number;
    revenueCents: number;
    lastOrderedAt: string | null;
    optionGroups: OptionGroup[];
  }>;
  offMenu: Array<{ name: string; quantity: number; orderLines: number; revenueCents: number }>;
}> {
  interface ItemRow {
    menuItemId: string;
    name: string;
    category: string;
    categoryOrder: number;
    priceCents: number;
    available: boolean;
    quantity: bigint;
    lines: bigint;
    revenue: bigint;
    lastOrderedAt: Date | null;
  }

  // Revenue is summed from the price stored on each line — what the guest was
  // charged — not from today's menu price, so a price change since does not
  // rewrite last month's takings.
  const [rows, options, offMenu] = await Promise.all([
    prisma.$queryRaw<ItemRow[]>`
      WITH sold AS (
        SELECT i."menuItemId",
               COUNT(*)                              AS lines,
               SUM(i.quantity)                       AS quantity,
               SUM(i.quantity * i."unitPriceCents")  AS revenue
        FROM order_items i
        JOIN orders o ON o.id = i."orderId"
        WHERE o."tenantId" = ${tenantId}::uuid
          AND o."locationId" = ${locationId}::uuid
          AND o.status <> 'canceled'
          AND o."createdAt" >= ${from}
          AND o."createdAt" <  ${to}
          AND i."menuItemId" IS NOT NULL
        GROUP BY 1
      ),
      ever AS (
        SELECT i."menuItemId", MAX(o."createdAt") AS last_ordered
        FROM order_items i
        JOIN orders o ON o.id = i."orderId"
        WHERE o."tenantId" = ${tenantId}::uuid
          AND o."locationId" = ${locationId}::uuid
          AND o.status <> 'canceled'
          AND i."menuItemId" IS NOT NULL
        GROUP BY 1
      )
      SELECT mi.id                        AS "menuItemId",
             mi.name                      AS name,
             mc.name                      AS category,
             mc."sortOrder"               AS "categoryOrder",
             mi."priceCents"              AS "priceCents",
             mi.available                 AS available,
             COALESCE(s.quantity, 0)      AS quantity,
             COALESCE(s.lines, 0)         AS lines,
             COALESCE(s.revenue, 0)       AS revenue,
             e.last_ordered               AS "lastOrderedAt"
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi."categoryId"
      JOIN menus m           ON m.id = mc."menuId"
      LEFT JOIN sold s ON s."menuItemId" = mi.id
      LEFT JOIN ever e ON e."menuItemId" = mi.id
      WHERE m."locationId" = ${locationId}::uuid
        AND m."tenantId" = ${tenantId}::uuid
        AND m.active
      ORDER BY COALESCE(s.quantity, 0) DESC, mi.name
    `,
    // What was chosen on each item — every topping on the pizza, every sauce
    // on the wings. Keyed by menu item id rather than by name, because this
    // view is built from the menu: two items that were renamed into each
    // other must not merge, and a line whose item has left the menu belongs
    // with the off-menu rows below, not here.
    //
    // Uncapped on purpose. The overview trims to the first few for a glance;
    // this is the detail, and its export is a record.
    prisma.$queryRaw<Array<{ menuItemId: string; group_name: string | null; option: string; quantity: bigint; lines: bigint }>>`
      SELECT i."menuItemId"    AS "menuItemId",
             g.name            AS group_name,
             m.name            AS option,
             SUM(i.quantity)   AS quantity,
             COUNT(*)          AS lines
      FROM order_items i
      JOIN orders o ON o.id = i."orderId"
      JOIN order_item_modifiers m ON m."orderItemId" = i.id
      LEFT JOIN menu_modifiers mm ON mm.id = m."modifierId"
      LEFT JOIN menu_modifier_groups g ON g.id = mm."modifierGroupId"
      WHERE o."tenantId" = ${tenantId}::uuid
        AND o."locationId" = ${locationId}::uuid
        AND o.status <> 'canceled'
        AND o."createdAt" >= ${from}
        AND o."createdAt" <  ${to}
        AND i."menuItemId" IS NOT NULL
      GROUP BY 1, 2, 3
      ORDER BY 4 DESC
    `,
    // Sold in the window but not on the menu now: an item since deleted, or a
    // line the menu could not price. Kept apart rather than dropped — the
    // money was taken either way, and a total that quietly omits it is wrong.
    prisma.$queryRaw<Array<{ name: string; quantity: bigint; lines: bigint; revenue: bigint }>>`
      SELECT i.name                              AS name,
             COUNT(*)                            AS lines,
             SUM(i.quantity)                     AS quantity,
             SUM(i.quantity * i."unitPriceCents") AS revenue
      FROM order_items i
      JOIN orders o ON o.id = i."orderId"
      WHERE o."tenantId" = ${tenantId}::uuid
        AND o."locationId" = ${locationId}::uuid
        AND o.status <> 'canceled'
        AND o."createdAt" >= ${from}
        AND o."createdAt" <  ${to}
        AND (
          i."menuItemId" IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM menu_items mi
            JOIN menu_categories mc ON mc.id = mi."categoryId"
            JOIN menus m           ON m.id = mc."menuId"
            WHERE mi.id = i."menuItemId"
              AND m."locationId" = ${locationId}::uuid
              AND m.active
          )
        )
      GROUP BY 1
      ORDER BY 3 DESC
    `,
  ]);

  const items = rows.map((r) => ({
    menuItemId: r.menuItemId,
    name: r.name,
    category: r.category,
    categoryOrder: r.categoryOrder,
    priceCents: r.priceCents,
    available: r.available,
    quantity: toNumber(r.quantity),
    orderLines: toNumber(r.lines),
    revenueCents: toNumber(r.revenue),
    lastOrderedAt: r.lastOrderedAt ? r.lastOrderedAt.toISOString() : null,
    // Which topping, which sauce — every one of them, kept in the group the
    // menu asks them in. "34 large pizzas" is a number; what went on them is
    // the thing a restaurant orders stock against.
    optionGroups: groupOptions(
      options.filter((o) => o.menuItemId === r.menuItemId),
      { groupsPerItem: Infinity, optionsPerGroup: Infinity },
    ),
  }));


  return {
    items,
    offMenu: offMenu.map((r) => ({
      name: r.name,
      quantity: toNumber(r.quantity),
      orderLines: toNumber(r.lines),
      revenueCents: toNumber(r.revenue),
    })),
  };
}

/** Dollars as a spreadsheet wants them: a plain number, no symbol. */
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location';
}

function sendCsv(reply: FastifyReply, filename: string, rows: Array<Array<string | number>>): FastifyReply {
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  return reply
    .type('text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${filename}.csv"`)
    .send(body);
}
