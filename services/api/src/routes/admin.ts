import type { FastifyInstance } from 'fastify';
import { prisma } from '@brayz/db';
import { PLANS, TRIAL_DAYS, isPaidAndServiceable } from '@brayz/billing';
import {
  AdminCallHistogramQuery,
  CALL_HISTOGRAM_MAX_BUCKETS,
  ExtendTrialInput,
  SetPlatformRoleInput,
  SupportStatus,
  TrialListState,
  UpdateSupportRequestInput,
  type BillingPlan,
  type CallHistogramBucket,
  type NodeHealthSnapshot,
  type SubscriptionStatus,
} from '@brayz/shared';
import { HttpError, notFound, parse } from '../lib/http.js';
import { trialInfo } from '../lib/billing.js';
import { assessNode, readSnapshot, type NodeAssessment } from '../lib/nodeHealth.js';
import { isKnownTimeZone } from '../lib/timezone.js';
import { requirePlatformStaff } from '../auth/platform.js';
import { writePlatformAudit } from '../lib/platformAudit.js';

/**
 * The Brayz staff admin portal.
 *
 * ## Why this file is allowed to read across tenants
 *
 * Rule #1 says every query carries a tenant. This file is the second and last
 * deliberate exception (after `lib/duplicates.ts`), and it earns it the same
 * way: the exception is confined to one file, every route is gated by
 * `requirePlatformStaff` — a role that lives in the database and that no
 * customer can grant themselves — and every read of an identifiable customer
 * is written to `platform_audit_logs` with who did it.
 *
 * Three rules hold here:
 *
 * 1. **Raw `prisma`, never `forTenant`.** Reading many tenants is the point,
 *    so the scoping extension is deliberately not used. That makes every query
 *    below something to read twice.
 * 2. **Aggregates, not contents.** Staff see counts, plans, and the support
 *    requests customers deliberately sent them. No route here returns a
 *    transcript, a recording, a guest, or an order — support that needs those
 *    is a conversation with the customer, not a back door.
 * 3. **No tenant-scoped route ever consults a platform role.** Being Brayz
 *    staff opens this portal and nothing else; it is not a master key that
 *    makes `/v1/locations/:id` answer for a restaurant you do not belong to.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long a call row may stay open and still count as live. The Orchestrator
 * records a call's end best-effort — a lost PATCH never fails a call — so a row
 * can outlive its call. Past this it is reported as stale instead of counted: a
 * live number that only ever creeps up is worse than none. The longest call on
 * brayz-dev so far is four minutes, so two hours is generous.
 */
const ACTIVE_WINDOW_MINUTES = 120;

/** A node that has taken a call this recently stays on the list, even at zero. */
const NODES_SEEN_DAYS = 7;

/**
 * The shortest each bucket can be, so the bucket-count check errs on the side
 * of refusing: a DST day is 23 hours, and a month is at least 28 of them.
 */
const MIN_BUCKET_MS: Record<CallHistogramBucket, number> = {
  hour: HOUR_MS,
  day: 23 * HOUR_MS,
  week: 7 * DAY_MS - HOUR_MS,
  month: 28 * DAY_MS - HOUR_MS,
};

/** Midnight UTC, `days` ago. Series and windows are UTC — staff, not guests. */
function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Monthly recurring revenue in cents for a plan that is actually being billed. */
function planMonthlyCents(plan: string | null): number {
  if (!plan) return 0;
  return PLANS[plan as BillingPlan]?.monthlyCents ?? 0;
}

/** Subscription states a restaurant is being charged for. */
const BILLED = ['active', 'trialing', 'past_due'];

interface LiveNode {
  /** The SiphonAI node's id, or null for calls that never said (before node ids existed). */
  nodeId: string | null;
  active: number;
  last24Hours: number;
  lastCallAt: Date | null;
  /** From the node's own heartbeat; null for a node that has never sent one. */
  health:
    | (NodeAssessment & {
        lastHeartbeatAt: Date;
        reportedActiveCalls: number;
        snapshot: NodeHealthSnapshot | null;
      })
    | null;
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /v1/admin/overview — the whole platform on one screen.
   *
   * Not audited: it identifies no customer. Everything below it is, except the
   * two call routes, which are counts of the same kind.
   */
  app.get('/v1/admin/overview', async (request) => {
    await requirePlatformStaff(request);
    const today = startOfTodayUtc();
    const d7 = daysAgo(7);
    const d30 = daysAgo(30);

    const [
      customers,
      locations,
      users,
      callsToday,
      calls7,
      calls30,
      callsTotal,
      subscriptions,
      supportOpen,
      supportInProgress,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.location.count(),
      prisma.user.count(),
      prisma.call.count({ where: { startedAt: { gte: today } } }),
      prisma.call.count({ where: { startedAt: { gte: d7 } } }),
      prisma.call.count({ where: { startedAt: { gte: d30 } } }),
      prisma.call.count(),
      prisma.locationSubscription.groupBy({
        by: ['plan', 'status'],
        _count: { _all: true },
      }),
      prisma.supportRequest.count({ where: { status: 'open' } }),
      prisma.supportRequest.count({ where: { status: 'in_progress' } }),
    ]);

    let mrrCents = 0;
    const byPlan: Record<string, { locations: number; mrrCents: number }> = {};
    const byStatus: Record<string, number> = {};
    for (const row of subscriptions) {
      const count = row._count._all;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + count;
      if (!BILLED.includes(row.status)) continue;
      const cents = planMonthlyCents(row.plan) * count;
      mrrCents += cents;
      const key = row.plan ?? 'unassigned';
      byPlan[key] = {
        locations: (byPlan[key]?.locations ?? 0) + count,
        mrrCents: (byPlan[key]?.mrrCents ?? 0) + cents,
      };
    }

    const paying = subscriptions
      .filter((r) => BILLED.includes(r.status))
      .reduce((n, r) => n + r._count._all, 0);

    return {
      customers: { total: customers },
      locations: { total: locations, subscribed: paying },
      users: { total: users },
      calls: { today: callsToday, last7Days: calls7, last30Days: calls30, total: callsTotal },
      revenue: { mrrCents, byPlan, byStatus },
      support: { open: supportOpen, inProgress: supportInProgress },
    };
  });

  /**
   * GET /v1/admin/calls/live — calls in progress right now, across every
   * customer, per SiphonAI node.
   *
   * "In progress" is a call row with no `endedAt` that started within
   * ACTIVE_WINDOW_MINUTES; older open rows are reported as `stale`, not
   * counted (see ACTIVE_WINDOW_MINUTES for why they happen).
   *
   * Nodes come from the calls themselves. Each call carries the node that
   * bridged it — the `?node=` on the media URL each node dials — because
   * SiphonAI never registers with `/v1/voice-nodes`, so a node is known by
   * having taken a call. One seen in the last NODES_SEEN_DAYS stays listed at
   * zero, so an idle node reads as idle rather than vanishing.
   *
   * Not audited: counts per node identify no customer.
   */
  app.get('/v1/admin/calls/live', async (request) => {
    await requirePlatformStaff(request);
    const now = new Date();
    const activeSince = new Date(now.getTime() - ACTIVE_WINDOW_MINUTES * 60_000);

    const weekAgo = new Date(now.getTime() - NODES_SEEN_DAYS * DAY_MS);
    const [active, stale, lastDay, seen, reporting] = await Promise.all([
      prisma.call.groupBy({
        by: ['nodeId'],
        where: { endedAt: null, startedAt: { gte: activeSince } },
        _count: { _all: true },
      }),
      prisma.call.count({ where: { endedAt: null, startedAt: { lt: activeSince } } }),
      prisma.call.groupBy({
        by: ['nodeId'],
        where: { startedAt: { gte: new Date(now.getTime() - DAY_MS) } },
        _count: { _all: true },
      }),
      prisma.call.groupBy({
        by: ['nodeId'],
        where: { startedAt: { gte: weekAgo } },
        _max: { startedAt: true },
      }),
      // Nodes that report in (brayz-node-heartbeat). A node is listed from its
      // first heartbeat, before it has taken a call, and stays listed — as
      // down — for a week after its last one.
      prisma.voiceNode.findMany({
        where: { lastSeenAt: { gte: weekAgo } },
        select: { nodeId: true, status: true, lastSeenAt: true, activeCalls: true, health: true },
      }),
    ]);

    const nodes = new Map<string | null, LiveNode>();
    const node = (nodeId: string | null): LiveNode => {
      let n = nodes.get(nodeId);
      if (!n) {
        n = { nodeId, active: 0, last24Hours: 0, lastCallAt: null, health: null };
        nodes.set(nodeId, n);
      }
      return n;
    };
    for (const r of seen) node(r.nodeId).lastCallAt = r._max.startedAt;
    for (const r of lastDay) node(r.nodeId).last24Hours = r._count._all;
    for (const r of active) node(r.nodeId).active = r._count._all;
    for (const r of reporting) {
      const snapshot = readSnapshot(r.health);
      node(r.nodeId).health = {
        ...assessNode({ status: r.status, lastSeenAt: r.lastSeenAt, health: snapshot }, now),
        lastHeartbeatAt: r.lastSeenAt,
        // The node's own count, beside ours from the call rows: a gap between
        // them is a call one side thinks is over and the other does not.
        reportedActiveCalls: r.activeCalls,
        snapshot,
      };
    }

    return {
      asOf: now,
      active: active.reduce((sum, r) => sum + r._count._all, 0),
      stale,
      activeWindowMinutes: ACTIVE_WINDOW_MINUTES,
      // Named nodes in order; calls that never said which node sort last.
      nodes: [...nodes.values()].sort((a, b) =>
        a.nodeId === null ? 1 : b.nodeId === null ? -1 : a.nodeId.localeCompare(b.nodeId),
      ),
    };
  });

  /**
   * GET /v1/admin/calls/histogram?bucket=&from=&to=&tz= — call volume over
   * time, every customer together.
   *
   * Buckets are cut in the viewer's timezone (a "day" is a day where the
   * reader is, not a UTC day) and the series is gap-free: a bucket with no
   * calls comes back as zero rather than missing, so a chart never has to
   * guess what a hole means. Hour buckets walk local wall-clock time, so the
   * hour a DST change skips reads as zero and the hour it repeats holds both.
   *
   * Not audited: a count per bucket identifies no customer.
   */
  app.get('/v1/admin/calls/histogram', async (request) => {
    await requirePlatformStaff(request);
    const q = parse(AdminCallHistogramQuery, request.query);
    const bucket: CallHistogramBucket = q.bucket ?? 'day';
    const tz = q.tz ?? 'UTC';
    if (!isKnownTimeZone(tz)) throw new HttpError(400, `Unknown timezone: ${tz}`, 'bad_timezone');
    const to = q.to ?? new Date();
    const from = q.from ?? new Date(to.getTime() - 30 * DAY_MS);
    if (from >= to) throw new HttpError(400, '`from` must be before `to`', 'bad_range');
    const buckets = Math.ceil((to.getTime() - from.getTime()) / MIN_BUCKET_MS[bucket]) + 1;
    if (buckets > CALL_HISTOGRAM_MAX_BUCKETS) {
      throw new HttpError(
        400,
        `That range is more than ${CALL_HISTOGRAM_MAX_BUCKETS} ${bucket}s — pick a larger bucket`,
        'too_many_buckets',
      );
    }

    // Raw SQL for date_trunc in a timezone and generate_series, neither of
    // which Prisma can express. Every value is a bound parameter; the bucket
    // is also constrained to four words by the schema. `startedAt` is a
    // timestamp holding UTC, hence the AT TIME ZONE 'UTC' before converting.
    const fromIso = from.toISOString();
    const toIso = to.toISOString();
    const step = `1 ${bucket}`;
    const rows = await prisma.$queryRaw<Array<{ bucket: string; calls: bigint }>>`
      WITH series AS (
        SELECT generate_series(
          date_trunc(${bucket}, ${fromIso}::timestamptz AT TIME ZONE ${tz}),
          date_trunc(${bucket}, (${toIso}::timestamptz - interval '1 millisecond') AT TIME ZONE ${tz}),
          ${step}::interval
        ) AS bucket
      ),
      counts AS (
        SELECT date_trunc(${bucket}, ("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}) AS bucket,
               COUNT(*) AS calls
        FROM calls
        WHERE "startedAt" >= (${fromIso}::timestamptz AT TIME ZONE 'UTC')
          AND "startedAt" <  (${toIso}::timestamptz AT TIME ZONE 'UTC')
        GROUP BY 1
      )
      SELECT to_char(s.bucket, 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             COALESCE(c.calls, 0) AS calls
      FROM series s
      LEFT JOIN counts c ON c.bucket = s.bucket
      ORDER BY s.bucket
    `;

    const points = rows.map((r) => ({ start: r.bucket, calls: Number(r.calls) }));
    return {
      bucket: q.bucket,
      tz: q.tz,
      from,
      to,
      total: points.reduce((sum, p) => sum + p.calls, 0),
      points,
    };
  });

  /** An active trial with this many days or fewer left is "ending soon". */
  const ENDING_SOON_DAYS = 7;
  /** The furthest out staff can set a trial's end. */
  const MAX_TRIAL_AHEAD_DAYS = 365;
  type TrialRowState = 'active' | 'ending' | 'expired' | 'converted';

  /**
   * GET /v1/admin/trials?state= — every account's free trial and how it is
   * going: how far through, how far it has got setting Brayz up, what it has
   * used, and — once lapsed — how many calls it is turning away.
   *
   * Audited: it names customers.
   */
  app.get('/v1/admin/trials', async (request) => {
    const actor = await requirePlatformStaff(request);
    const { state } = request.query as { state?: string };
    const parsed = TrialListState.safeParse(state ?? 'all');
    const wanted = parsed.success ? parsed.data : 'all';
    const now = new Date();
    const counts: Record<TrialRowState, number> = { active: 0, ending: 0, expired: 0, converted: 0 };

    const tenants = await prisma.tenant.findMany({
      where: { trialEndsAt: { not: null } },
      orderBy: { trialEndsAt: 'asc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
        memberships: {
          where: { role: 'owner' },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { user: { select: { email: true, displayName: true } } },
        },
        locations: { select: { subscription: { select: { plan: true, status: true } } } },
      },
    });
    const ids = tenants.map((t) => t.id);
    if (!ids.length) {
      await writePlatformAudit({ actor, action: 'admin.trials.listed', metadata: { state: wanted, count: 0 } });
      return { trials: [], counts, trialDays: TRIAL_DAYS };
    }

    // Each account's calls and orders counted against its own trial window, in
    // one pass per table rather than a query per account.
    const [calls, orders, numbers, menuItems, extensions] = await Promise.all([
      prisma.$queryRaw<Array<{ tenantId: string; during: bigint; after: bigint; first: Date | null }>>`
        SELECT t.id AS "tenantId",
               COUNT(c.id) FILTER (WHERE c."startedAt" >= COALESCE(t."trialStartedAt", t."createdAt")
                                     AND c."startedAt" < t."trialEndsAt") AS during,
               COUNT(c.id) FILTER (WHERE c."startedAt" >= t."trialEndsAt") AS after,
               MIN(c."startedAt") AS first
        FROM tenants t
        LEFT JOIN calls c ON c."tenantId" = t.id
        WHERE t.id = ANY(${ids}::uuid[])
        GROUP BY t.id
      `,
      prisma.$queryRaw<Array<{ tenantId: string; during: bigint; first: Date | null }>>`
        SELECT t.id AS "tenantId",
               COUNT(o.id) FILTER (WHERE o.status <> 'canceled'
                                     AND o."createdAt" >= COALESCE(t."trialStartedAt", t."createdAt")
                                     AND o."createdAt" < t."trialEndsAt") AS during,
               MIN(o."createdAt") FILTER (WHERE o.status <> 'canceled') AS first
        FROM tenants t
        LEFT JOIN orders o ON o."tenantId" = t.id
        WHERE t.id = ANY(${ids}::uuid[])
        GROUP BY t.id
      `,
      prisma.phoneNumber.groupBy({
        by: ['tenantId'],
        where: { tenantId: { in: ids }, active: true },
        _count: { _all: true },
      }),
      prisma.$queryRaw<Array<{ tenantId: string; items: bigint }>>`
        SELECT m."tenantId" AS "tenantId", COUNT(i.id) AS items
        FROM menus m
        JOIN menu_categories mc ON mc."menuId" = m.id
        JOIN menu_items i ON i."categoryId" = mc.id
        WHERE m."tenantId" = ANY(${ids}::uuid[]) AND i.available
        GROUP BY m."tenantId"
      `,
      prisma.platformAuditLog.groupBy({
        by: ['targetId'],
        where: {
          targetType: 'tenant',
          targetId: { in: ids },
          action: { in: ['admin.trial.extended', 'admin.trial.granted'] },
        },
        _count: { _all: true },
      }),
    ]);
    const callsBy = new Map(calls.map((r) => [r.tenantId, r]));
    const ordersBy = new Map(orders.map((r) => [r.tenantId, r]));
    const numbersBy = new Map(numbers.map((r) => [r.tenantId, r._count._all]));
    const itemsBy = new Map(menuItems.map((r) => [r.tenantId, Number(r.items)]));
    const extensionsBy = new Map(extensions.map((r) => [r.targetId, r._count._all]));

    const rows = tenants.map((t) => {
      const endsAt = t.trialEndsAt as Date;
      const startedAt = t.trialStartedAt ?? t.createdAt;
      const info = trialInfo(startedAt, endsAt, now)!;
      const converted = t.locations.some(
        (l) =>
          l.subscription &&
          isPaidAndServiceable(l.subscription.plan as BillingPlan | null, l.subscription.status as SubscriptionStatus),
      );
      const state: TrialRowState = converted
        ? 'converted'
        : info.active
          ? info.daysLeft <= ENDING_SOON_DAYS
            ? 'ending'
            : 'active'
          : 'expired';
      const daysTotal = Math.max(1, Math.round((endsAt.getTime() - startedAt.getTime()) / DAY_MS));
      const c = callsBy.get(t.id);
      const o = ordersBy.get(t.id);
      const owner = t.memberships[0]?.user;
      counts[state] += 1;
      return {
        tenantId: t.id,
        name: t.name,
        ownerEmail: owner?.email ?? null,
        ownerName: owner?.displayName ?? null,
        startedAt,
        endsAt,
        daysLeft: info.daysLeft,
        daysTotal,
        daysUsed: Math.max(0, Math.min(daysTotal, Math.floor((now.getTime() - startedAt.getTime()) / DAY_MS))),
        state,
        extensions: extensionsBy.get(t.id) ?? 0,
        setup: {
          locations: t.locations.length,
          numbersLive: numbersBy.get(t.id) ?? 0,
          menuItems: itemsBy.get(t.id) ?? 0,
          firstCallAt: c?.first ?? null,
          firstOrderAt: o?.first ?? null,
        },
        usage: {
          callsDuringTrial: Number(c?.during ?? 0),
          ordersDuringTrial: Number(o?.during ?? 0),
          // Calls since the trial ended; while unpaid, each one was forwarded
          // or turned away rather than answered.
          callsSinceEnded: Number(c?.after ?? 0),
        },
      };
    });

    const shown =
      wanted === 'all'
        ? rows
        : wanted === 'active'
          ? rows.filter((r) => r.state === 'active' || r.state === 'ending')
          : rows.filter((r) => r.state === wanted);
    await writePlatformAudit({ actor, action: 'admin.trials.listed', metadata: { state: wanted, count: shown.length } });
    return { trials: shown, counts, trialDays: TRIAL_DAYS };
  });

  /**
   * POST /v1/admin/trials/:tenantId/extend — more time on a customer's free
   * trial, or a trial for an account that never had one. `admin` only, like
   * answering support: it changes what a customer gets for free. Days count
   * from the later of now and the current end, so a lapsed trial restarts
   * today; or an exact end, at most MAX_TRIAL_AHEAD_DAYS out. Always with a
   * reason, which goes in the audit trail — that trail is the trial's history.
   */
  app.post('/v1/admin/trials/:tenantId/extend', async (request) => {
    const actor = await requirePlatformStaff(request, 'admin');
    const { tenantId } = request.params as { tenantId: string };
    const input = parse(ExtendTrialInput, request.body);
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, trialStartedAt: true, trialEndsAt: true },
    });
    if (!tenant) throw notFound('Customer');

    const now = new Date();
    let endsAt: Date;
    if (input.endsAt !== undefined) {
      endsAt = new Date(input.endsAt as unknown as Date);
      if (endsAt <= now) throw new HttpError(400, 'The new end must be in the future', 'bad_trial_end');
      if (endsAt.getTime() > now.getTime() + MAX_TRIAL_AHEAD_DAYS * DAY_MS) {
        throw new HttpError(400, `A trial can run at most ${MAX_TRIAL_AHEAD_DAYS} days from today`, 'bad_trial_end');
      }
    } else {
      const base = tenant.trialEndsAt && tenant.trialEndsAt > now ? tenant.trialEndsAt : now;
      endsAt = new Date(base.getTime() + (input.days ?? 0) * DAY_MS);
    }

    const granted = !tenant.trialEndsAt;
    const updated = await prisma.tenant.update({
      where: { id: tenantId },
      data: { trialEndsAt: endsAt, ...(granted ? { trialStartedAt: now } : {}) },
      select: { trialStartedAt: true, trialEndsAt: true },
    });
    await writePlatformAudit({
      actor,
      action: granted ? 'admin.trial.granted' : 'admin.trial.extended',
      targetType: 'tenant',
      targetId: tenantId,
      metadata: {
        name: tenant.name,
        from: tenant.trialEndsAt,
        to: endsAt,
        days: input.days ?? null,
        reason: input.reason,
      },
    });
    return { tenantId, granted, ...trialInfo(updated.trialStartedAt, updated.trialEndsAt, now) };
  });

  /**
   * GET /v1/admin/customers — every restaurant, with how to reach them and how
   * much they are using Brayz.
   */
  app.get('/v1/admin/customers', async (request) => {
    const actor = await requirePlatformStaff(request);
    const { q } = request.query as { q?: string };
    const search = q?.trim();

    const tenants = await prisma.tenant.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { locations: { some: { name: { contains: search, mode: 'insensitive' } } } },
              { memberships: { some: { user: { email: { contains: search, mode: 'insensitive' } } } } },
            ],
          }
        : undefined,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        createdAt: true,
        locations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            mainPhone: true,
            city: true,
            region: true,
            subscription: { select: { plan: true, status: true } },
          },
        },
        memberships: {
          orderBy: { createdAt: 'asc' },
          select: { role: true, user: { select: { email: true, displayName: true } } },
        },
      },
    });

    const tenantIds = tenants.map((t) => t.id);
    const [calls30, supportOpen] = await Promise.all([
      tenantIds.length
        ? prisma.call.groupBy({
            by: ['tenantId'],
            where: { tenantId: { in: tenantIds }, startedAt: { gte: daysAgo(30) } },
            _count: { _all: true },
          })
        : [],
      tenantIds.length
        ? prisma.supportRequest.groupBy({
            by: ['tenantId'],
            where: { tenantId: { in: tenantIds }, status: { in: ['open', 'in_progress'] } },
            _count: { _all: true },
          })
        : [],
    ]);
    const callsByTenant = new Map(calls30.map((r) => [r.tenantId, r._count._all]));
    const supportByTenant = new Map(supportOpen.map((r) => [r.tenantId, r._count._all]));

    await writePlatformAudit({
      actor,
      action: 'admin.customers.listed',
      metadata: { count: tenants.length, query: search ?? null },
    });

    return {
      customers: tenants.map((t) => {
        const owner =
          t.memberships.find((m) => m.role === 'owner') ?? t.memberships[0] ?? null;
        return {
          tenantId: t.id,
          name: t.name,
          createdAt: t.createdAt,
          locationCount: t.locations.length,
          // Contact: the owner's account, and the first location's public phone.
          contactEmail: owner?.user.email ?? null,
          contactName: owner?.user.displayName ?? null,
          mainPhone: t.locations.find((l) => l.mainPhone)?.mainPhone ?? null,
          city: t.locations[0]?.city ?? null,
          region: t.locations[0]?.region ?? null,
          calls30d: callsByTenant.get(t.id) ?? 0,
          openSupport: supportByTenant.get(t.id) ?? 0,
          // A tenant has one plan per location; show the best one it is on.
          plans: Array.from(
            new Set(
              t.locations
                .map((l) => l.subscription?.plan)
                .filter((p): p is string => Boolean(p)),
            ),
          ),
          subscribedLocations: t.locations.filter((l) =>
            l.subscription ? BILLED.includes(l.subscription.status) : false,
          ).length,
        };
      }),
    };
  });

  /** GET /v1/admin/customers/:tenantId — one restaurant in detail. */
  app.get('/v1/admin/customers/:tenantId', async (request) => {
    const actor = await requirePlatformStaff(request);
    const { tenantId } = request.params as { tenantId: string };

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        createdAt: true,
        trialStartedAt: true,
        trialEndsAt: true,
        locations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            timezone: true,
            mainPhone: true,
            addressLine1: true,
            city: true,
            region: true,
            postalCode: true,
            createdAt: true,
            subscription: {
              select: { plan: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
            },
          },
        },
        memberships: {
          orderBy: { createdAt: 'asc' },
          select: {
            role: true,
            createdAt: true,
            user: { select: { id: true, email: true, displayName: true } },
          },
        },
      },
    });
    if (!tenant) throw notFound('Customer');

    const locationIds = tenant.locations.map((l) => l.id);
    const [callsTotal, callsToday, calls30, perLocation, support] = await Promise.all([
      prisma.call.count({ where: { tenantId } }),
      prisma.call.count({ where: { tenantId, startedAt: { gte: startOfTodayUtc() } } }),
      prisma.call.count({ where: { tenantId, startedAt: { gte: daysAgo(30) } } }),
      locationIds.length
        ? prisma.call.groupBy({
            by: ['locationId'],
            where: { tenantId, startedAt: { gte: daysAgo(30) } },
            _count: { _all: true },
          })
        : [],
      prisma.supportRequest.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true,
          subject: true,
          severity: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
        },
      }),
    ]);
    const callsByLocation = new Map(perLocation.map((r) => [r.locationId, r._count._all]));

    await writePlatformAudit({
      actor,
      action: 'admin.customer.viewed',
      targetType: 'tenant',
      targetId: tenantId,
      metadata: { name: tenant.name },
    });

    return {
      tenantId: tenant.id,
      name: tenant.name,
      createdAt: tenant.createdAt,
      calls: { today: callsToday, last30Days: calls30, total: callsTotal },
      mrrCents: tenant.locations.reduce(
        (sum, l) =>
          sum +
          (l.subscription && BILLED.includes(l.subscription.status)
            ? planMonthlyCents(l.subscription.plan)
            : 0),
        0,
      ),
      members: tenant.memberships.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        displayName: m.user.displayName,
        role: m.role,
        since: m.createdAt,
      })),
      locations: tenant.locations.map((l) => ({
        id: l.id,
        name: l.name,
        timezone: l.timezone,
        mainPhone: l.mainPhone,
        address: [l.addressLine1, l.city, l.region, l.postalCode].filter(Boolean).join(', ') || null,
        createdAt: l.createdAt,
        calls30d: callsByLocation.get(l.id) ?? 0,
        plan: l.subscription?.plan ?? null,
        subscriptionStatus: l.subscription?.status ?? 'none',
        currentPeriodEnd: l.subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: l.subscription?.cancelAtPeriodEnd ?? false,
      })),
      supportRequests: support,
      // The free trial, and every change staff made to it — the audit trail is
      // its history. Null for an account from before trials.
      trial: tenant.trialEndsAt
        ? {
            ...trialInfo(tenant.trialStartedAt, tenant.trialEndsAt)!,
            history: (
              await prisma.platformAuditLog.findMany({
                where: {
                  targetType: 'tenant',
                  targetId: tenantId,
                  action: { in: ['admin.trial.extended', 'admin.trial.granted'] },
                },
                orderBy: { createdAt: 'desc' },
                take: 20,
                select: { createdAt: true, actorEmail: true, action: true, metadata: true },
              })
            ).map((e) => {
              const m = (e.metadata ?? {}) as { from?: string | null; to?: string; days?: number | null; reason?: string };
              return {
                at: e.createdAt,
                actorEmail: e.actorEmail,
                action: e.action,
                from: m.from ?? null,
                to: m.to ?? null,
                days: m.days ?? null,
                reason: m.reason ?? '',
              };
            }),
          }
        : null,
    };
  });

  /** GET /v1/admin/support-requests?status= — the queue. */
  app.get('/v1/admin/support-requests', async (request) => {
    await requirePlatformStaff(request);
    const { status } = request.query as { status?: string };
    const parsed = status && status !== 'all' ? SupportStatus.safeParse(status) : null;

    const requests = await prisma.supportRequest.findMany({
      where: parsed?.success ? { status: parsed.data } : undefined,
      // Oldest open first: a queue, not a feed.
      orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        subject: true,
        body: true,
        severity: true,
        status: true,
        staffReply: true,
        repliedAt: true,
        resolvedAt: true,
        createdAt: true,
        tenant: { select: { name: true } },
        location: { select: { name: true, mainPhone: true } },
        createdBy: { select: { email: true, displayName: true } },
      },
    });

    return {
      requests: requests.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        tenantName: r.tenant.name,
        locationId: r.locationId,
        locationName: r.location?.name ?? null,
        locationPhone: r.location?.mainPhone ?? null,
        subject: r.subject,
        body: r.body,
        severity: r.severity,
        status: r.status,
        staffReply: r.staffReply,
        repliedAt: r.repliedAt,
        resolvedAt: r.resolvedAt,
        createdAt: r.createdAt,
        fromEmail: r.createdBy?.email ?? null,
        fromName: r.createdBy?.displayName ?? null,
      })),
    };
  });

  /**
   * PATCH /v1/admin/support-requests/:id — answer or advance one.
   *
   * `admin` only: a reply is written to a customer under the Brayz name, which
   * is a different thing from being able to read the queue.
   */
  app.patch('/v1/admin/support-requests/:id', async (request) => {
    const actor = await requirePlatformStaff(request, 'admin');
    const { id } = request.params as { id: string };
    const input = parse(UpdateSupportRequestInput, request.body);

    const existing = await prisma.supportRequest.findUnique({
      where: { id },
      select: { id: true, tenantId: true, status: true },
    });
    if (!existing) throw notFound('Support request');

    const replying = input.staffReply !== undefined && input.staffReply !== null;
    const updated = await prisma.supportRequest.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.staffReply !== undefined ? { staffReply: input.staffReply } : {}),
        ...(replying ? { repliedAt: new Date() } : {}),
        // Resolving stamps the time; reopening clears it, so "resolved" and
        // "has a resolvedAt" never disagree.
        ...(input.status === 'resolved'
          ? { resolvedAt: new Date() }
          : input.status
            ? { resolvedAt: null }
            : {}),
      },
      select: { id: true, status: true, staffReply: true, repliedAt: true, resolvedAt: true },
    });

    await writePlatformAudit({
      actor,
      action: 'admin.support_request.updated',
      targetType: 'support_request',
      targetId: id,
      metadata: {
        tenantId: existing.tenantId,
        from: existing.status,
        to: updated.status,
        replied: replying,
      },
    });
    return updated;
  });

  /** GET /v1/admin/staff — who on the Brayz side can open this portal. */
  app.get('/v1/admin/staff', async (request) => {
    await requirePlatformStaff(request);
    const staff = await prisma.user.findMany({
      where: { platformRole: { not: null } },
      orderBy: { email: 'asc' },
      select: { id: true, email: true, displayName: true, platformRole: true, createdAt: true },
    });
    return { staff };
  });

  /**
   * POST /v1/admin/staff — grant or revoke Brayz staff access.
   *
   * `admin` only, and an admin cannot demote themselves: the last admin
   * removing their own access would leave the portal unreachable by anyone,
   * recoverable only by editing the database by hand.
   */
  app.post('/v1/admin/staff', async (request) => {
    const actor = await requirePlatformStaff(request, 'admin');
    const input = parse(SetPlatformRoleInput, request.body);
    const email = input.email.toLowerCase();

    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
    if (!user) throw notFound('User (they must sign in to Brayz once first)');
    if (user.id === actor.userId && input.role !== 'admin') {
      throw new HttpError(400, 'You cannot remove your own admin access', 'bad_request');
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { platformRole: input.role },
      select: { id: true, email: true, displayName: true, platformRole: true },
    });
    await writePlatformAudit({
      actor,
      action: input.role ? 'admin.staff.granted' : 'admin.staff.revoked',
      targetType: 'user',
      targetId: user.id,
      metadata: { email: user.email, role: input.role },
    });
    return updated;
  });

  /** GET /v1/admin/audit — what Brayz staff have been doing. */
  app.get('/v1/admin/audit', async (request) => {
    await requirePlatformStaff(request, 'admin');
    const entries = await prisma.platformAuditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return { entries };
  });
}
