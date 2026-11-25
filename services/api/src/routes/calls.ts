import type { FastifyInstance } from 'fastify';
import { AppendTranscriptInput, CallEventInput, EnsureCallInput, UpdateCallInput,
  CallDaysQuery,
  ListCallsQuery,
} from '@brayz/shared';
import { forTenant, prisma, writeAudit, Prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { isKnownTimeZone } from '../lib/timezone.js';
import { locationService } from '../lib/billing.js';
import { requireNode } from '../auth/node.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import { Readable } from 'node:stream';
import { loadConfig } from '@brayz/config';
import {
  buildRecordingStorage,
  parseObjectUri,
  type RecordingStorage,
} from '../lib/recordingStorage.js';

/**
 * Call lifecycle. The voice plane (Siphon-AI / Orchestrator, node-authed) creates
 * call records and appends events; the dashboard (user-authed, tenant-scoped)
 * reads them. The Orchestrator persists through this API, never raw tables
 * (CLAUDE.md rule #5).
 */
export interface CallRouteOptions {
  /** Inject object storage (tests). Defaults to whatever config describes. */
  recordingStorage?: RecordingStorage | null;
}

export async function callRoutes(
  app: FastifyInstance,
  opts: CallRouteOptions = {},
): Promise<void> {
  const cfg = loadConfig();
  const storage = opts.recordingStorage === undefined ? buildRecordingStorage(cfg) : opts.recordingStorage;

  // ---- Voice plane (node-authed) ----

  // Create-or-find the call for a media session; resolves tenant/location from
  // the called number.
  app.post('/v1/calls', async (request, reply) => {
    requireNode(request);
    const input = parse(EnsureCallInput, request.body);

    const phone = await prisma.phoneNumber.findUnique({
      where: { e164Number: input.toNumber },
      select: { tenantId: true, locationId: true, active: true },
    });
    if (!phone || !phone.active) {
      throw new HttpError(404, `No active location for ${input.toNumber}`, 'number_not_provisioned');
    }

    // Recognize a returning caller: a known phone → its guest (tenant-scoped).
    // Records only — whether the bot personalizes is gated later by the location's
    // guestMemoryMode + the guest's opt-out (CLAUDE.md rule #6).
    let guestId: string | undefined;
    if (input.fromNumber) {
      const known = await prisma.guestPhoneNumber.findUnique({
        where: { tenantId_e164: { tenantId: phone.tenantId, e164: input.fromNumber } },
        select: { guestId: true },
      });
      guestId = known?.guestId;
    }

    const data = {
      tenantId: phone.tenantId,
      locationId: phone.locationId,
      provider: input.provider,
      providerCallId: input.providerCallId,
      fromNumber: input.fromNumber,
      toNumber: input.toNumber,
      guestId,
      // The SiphonAI node that bridged it, for the staff portal's live count.
      // The schema has already dropped a malformed one.
      nodeId: typeof input.nodeId === 'string' ? input.nodeId : undefined,
    };

    const call = input.callId
      ? await prisma.call.upsert({
          where: { id: input.callId },
          update: {},
          create: { id: input.callId, status: 'started', ...data },
        })
      : await prisma.call.create({ data: { status: 'started', ...data } });

    // Whether the AI should take this call at all. An account whose free trial
    // lapsed with nothing paid for is out of service: the call is still
    // recorded — the restaurant and Brayz staff should see what it is missing —
    // and the Orchestrator rings it through to the restaurant or says it cannot
    // be taken. An Orchestrator that predates this ignores `service`.
    const service = await locationService(phone.locationId);
    if (!service.inService) {
      await prisma.callEvent.create({
        data: {
          callId: call.id,
          eventType: 'call.out_of_service',
          payload: { reason: service.reason, forwarded: Boolean(service.forwardTo) },
        },
      });
    }

    return reply.status(201).send({
      id: call.id,
      tenantId: call.tenantId,
      locationId: call.locationId,
      status: call.status,
      service,
    });
  });

  // Append a lifecycle event and advance call status accordingly.
  app.post('/v1/calls/:callId/events', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(CallEventInput, request.body);

    const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true } });
    if (!call) throw notFound('Call');

    const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
    await prisma.callEvent.create({
      data: {
        callId,
        eventType: input.eventType,
        occurredAt,
        payload: input.payload as Prisma.InputJsonValue,
      },
    });

    const statusPatch = statusForEvent(input.eventType, occurredAt);
    if (statusPatch) await prisma.call.update({ where: { id: callId }, data: statusPatch });

    return reply.status(201).send({ ok: true });
  });

  // Append transcript turns as the conversation happens. Append-only and
  // atomic (`turns || excluded.turns`) so concurrent caller/agent writes on one
  // call can't clobber each other the way a read-modify-write would.
  app.post('/v1/calls/:callId/transcript/turns', async (request, reply) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(AppendTranscriptInput, request.body);

    const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true } });
    if (!call) throw notFound('Call');

    const turns = input.turns.map((turn) => ({ ...turn, at: turn.at ?? new Date().toISOString() }));
    await prisma.$executeRaw`
      INSERT INTO call_transcripts (id, "callId", turns, "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${callId}::uuid, ${JSON.stringify(turns)}::jsonb, now(), now())
      ON CONFLICT ("callId") DO UPDATE
        SET turns = call_transcripts.turns || EXCLUDED.turns, "updatedAt" = now()
    `;
    return reply.status(201).send({ ok: true, appended: turns.length });
  });

  app.patch('/v1/calls/:callId', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(UpdateCallInput, request.body);
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { id: true } });
    if (!call) throw notFound('Call');
    return prisma.call.update({
      where: { id: callId },
      data: {
        status: input.status,
        summary: input.summary,
        recordingStatus: input.recordingStatus,
        recordingId: input.recordingId,
        recordingUrl: input.recordingUrl,
        endedAt: input.endedAt ? new Date(input.endedAt) : undefined,
      },
    });
  });

  // ---- Dashboard (user-authed, tenant-scoped) ----

  /**
   * A page of calls, newest first, inside an optional time range.
   *
   * This used to be "the newest hundred", which a busy restaurant would scroll
   * off by mid-afternoon with no way to reach the morning. Keyset paging on
   * (startedAt, id): a cursor names the last row seen, so a call arriving
   * between pages shifts nothing already read.
   */
  app.get('/v1/locations/:locationId/calls', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(ListCallsQuery, request.query);
    const limit = q.limit ?? 50;
    const db = forTenant(tenantId);
    const page = await db.call.findMany({
      where: { locationId, ...rangeWhere(q.from, q.to), ...cursorWhere(q.cursor) },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const calls = page.slice(0, limit);
    const last = calls[calls.length - 1];
    return {
      calls: calls.map(withoutRecordingUrl),
      nextCursor: page.length > limit && last ? encodeCursor(last) : null,
    };
  });

  /**
   * How many calls each day had, and what came of them — the collapsed rows
   * of the Calls screen. Days are the restaurant's days: a 12:30 am call in
   * New York belongs to that evening's service, not to tomorrow, so the
   * grouping happens in the location's timezone rather than UTC.
   */
  app.get('/v1/locations/:locationId/calls/days', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const q = parse(CallDaysQuery, request.query);
    const tz = q.tz ?? 'UTC';
    if (!isKnownTimeZone(tz)) throw new HttpError(400, `Unknown timezone: ${tz}`, 'bad_timezone');
    const location = await forTenant(tenantId).location.findFirst({
      where: { id: locationId },
      select: { id: true },
    });
    if (!location) throw notFound('Location');
    // Raw SQL for the date_trunc-in-a-timezone, which Prisma cannot express.
    // Tenant and location are both in the WHERE (rule #1); the timezone is a
    // bound parameter, never interpolated.
    const from = q.from ?? new Date(0);
    const to = q.to ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const rows = await prisma.$queryRaw<
      Array<{ day: string; calls: bigint; orders: bigint; transferred: bigint; failed: bigint }>
    >`
      SELECT to_char(("startedAt" AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS day,
             COUNT(*)                                                       AS calls,
             COUNT(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM orders o WHERE o."callId" = c.id AND o.status <> 'canceled'))  AS orders,
             COUNT(*) FILTER (WHERE c.status = 'transferred')               AS transferred,
             COUNT(*) FILTER (WHERE c.status = 'failed')                    AS failed
      FROM calls c
      WHERE c."tenantId" = ${tenantId}::uuid
        AND c."locationId" = ${locationId}::uuid
        AND c."startedAt" >= ${from}
        AND c."startedAt" < ${to}
      GROUP BY 1
      ORDER BY 1 DESC
    `;
    return {
      tz,
      days: rows.map((r) => ({
        day: r.day,
        calls: Number(r.calls),
        orders: Number(r.orders),
        transferred: Number(r.transferred),
        failed: Number(r.failed),
      })),
    };
  });

  /**
   * The calls in a range as CSV, for a restaurant that wants its own record
   * past whatever the dashboard shows. Streamed a page at a time so a year of
   * calls never has to fit in memory. Manager and up, and audited: it hands
   * out every caller's phone number in one file. Transcripts are deliberately
   * not in it — that would make one download a much larger privacy artefact;
   * they stay per call on the Calls screen.
   */
  app.get('/v1/locations/:locationId/calls/export.csv', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const q = parse(CallDaysQuery, request.query);
    const tz = q.tz ?? 'UTC';
    if (!isKnownTimeZone(tz)) throw new HttpError(400, `Unknown timezone: ${tz}`, 'bad_timezone');
    const db = forTenant(tenantId);
    const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true, name: true } });
    if (!location) throw notFound('Location');

    await writeAudit({
      tenantId,
      locationId,
      actorId: request.auth?.userId ?? null,
      action: 'calls.exported',
      targetType: 'location',
      targetId: locationId,
      metadata: { from: q.from?.toISOString() ?? null, to: q.to?.toISOString() ?? null, tz },
    });

    async function* rows(): AsyncGenerator<string> {
      yield `${CSV_COLUMNS.join(',')}\n`;
      let cursor: string | undefined;
      for (;;) {
        const page = await db.call.findMany({
          where: { locationId, ...rangeWhere(q.from, q.to), ...cursorWhere(cursor) },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
          take: 500,
          include: {
            orders: {
              where: { status: { not: 'canceled' } },
              select: { id: true, totalCents: true, customerName: true },
            },
          },
        });
        for (const c of page) yield csvLine(c, tz);
        const last = page[page.length - 1];
        if (page.length < 500 || !last) return;
        cursor = encodeCursor(last);
      }
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="calls-${slug(location.name)}-${stamp}.csv"`)
      .send(Readable.from(rows()));
  });

  app.get('/v1/calls/:callId', async (request) => {
    const tenantId = requireTenant(request);
    const { callId } = request.params as { callId: string };
    const db = forTenant(tenantId);
    const call = await db.call.findFirst({
      where: { id: callId },
      include: { events: { orderBy: { occurredAt: 'asc' } } },
    });
    if (!call) throw notFound('Call');
    return withoutRecordingUrl(call);
  });

  /**
   * Where the call's recording lives. Split out from the call itself so that
   * reaching for a recording is a deliberate act that leaves an audit entry
   * (rule #6) — rather than the location riding along in every list response
   * that happens to be rendered.
   */
  app.get('/v1/calls/:callId/recording', async (request) => {
    const tenantId = requireTenant(request);
    const { callId } = request.params as { callId: string };
    const db = forTenant(tenantId);
    const call = await db.call.findFirst({
      where: { id: callId },
      select: { id: true, locationId: true, recordingStatus: true, recordingUrl: true },
    });
    if (!call) throw notFound('Call');
    if (!call.recordingUrl) {
      throw new HttpError(404, 'No recording for this call', 'recording_unavailable');
    }
    await writeAudit({
      tenantId,
      locationId: call.locationId,
      actorId: request.auth?.userId ?? null,
      action: 'recording.accessed',
      targetType: 'call',
      targetId: call.id,
    });

    // A signed URL when we have credentials for the bucket, so the browser can
    // actually play it. Without them the stored object URI is all we can give —
    // the recording exists, we just cannot reach it yet.
    const loc = parseObjectUri(call.recordingUrl);
    const playbackUrl =
      storage && loc ? storage.signedUrl(loc, cfg.RECORDING_URL_TTL_SECONDS) : null;
    return {
      status: call.recordingStatus,
      url: call.recordingUrl,
      playbackUrl,
      expiresInSeconds: playbackUrl ? cfg.RECORDING_URL_TTL_SECONDS : null,
    };
  });

  app.get('/v1/calls/:callId/transcript', async (request) => {
    const tenantId = requireTenant(request);
    const { callId } = request.params as { callId: string };
    const db = forTenant(tenantId);
    const call = await db.call.findFirst({ where: { id: callId }, select: { id: true } });
    if (!call) throw notFound('Call');
    const transcript = await prisma.callTranscript.findUnique({ where: { callId } });
    return transcript ?? { callId, turns: [] };
  });
}

/** Map a lifecycle event to a call-status patch, if any. */
function statusForEvent(
  eventType: string,
  at: Date,
): { status: string; answeredAt?: Date; endedAt?: Date } | null {
  switch (eventType) {
    case 'call.answered':
    case 'call.media_started':
      return { status: 'in_progress', answeredAt: at };
    case 'call.transferred':
      return { status: 'transferred' };
    case 'call.completed':
      return { status: 'completed', endedAt: at };
    case 'call.failed':
      return { status: 'failed', endedAt: at };
    default:
      return null;
  }
}

/**
 * Drop the recording's location from a call payload. It is served only by the
 * audited `/recording` route, so it must not leak through a plain read.
 */
function withoutRecordingUrl<T extends { recordingUrl?: string | null }>(call: T): Omit<T, 'recordingUrl'> {
  const { recordingUrl: _omitted, ...rest } = call;
  return rest;
}

// ---- Calls list helpers ----

function rangeWhere(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
}

/** Rows strictly after the cursor in (startedAt desc, id desc) order. */
function cursorWhere(cursor?: string) {
  if (!cursor) return {};
  const c = decodeCursor(cursor);
  return {
    OR: [{ startedAt: { lt: c.startedAt } }, { startedAt: c.startedAt, id: { lt: c.id } }],
  };
}

function encodeCursor(row: { startedAt: Date; id: string }): string {
  return Buffer.from(`${row.startedAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const startedAt = iso ? new Date(iso) : new Date(NaN);
  if (!id || Number.isNaN(startedAt.getTime())) {
    throw new HttpError(400, 'Bad cursor', 'bad_cursor');
  }
  return { startedAt, id };
}

const CSV_COLUMNS = [
  'started_local',
  'started_utc',
  'from',
  'to',
  'status',
  'duration_seconds',
  'customer_name',
  'orders',
  'order_total',
  'recording',
  'summary',
];

function csvLine(
  c: {
    startedAt: Date;
    endedAt: Date | null;
    fromNumber: string | null;
    toNumber: string | null;
    status: string;
    summary: string | null;
    recordingStatus: string | null;
    orders: Array<{ totalCents: number; customerName: string | null }>;
  },
  tz: string,
): string {
  const seconds = c.endedAt ? Math.max(0, Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000)) : '';
  const total = c.orders.reduce((sum, o) => sum + o.totalCents, 0);
  const cells = [
    localStamp(c.startedAt, tz),
    c.startedAt.toISOString(),
    c.fromNumber ?? '',
    c.toNumber ?? '',
    c.status,
    seconds,
    c.orders.find((o) => o.customerName)?.customerName ?? '',
    c.orders.length,
    c.orders.length ? (total / 100).toFixed(2) : '',
    c.recordingStatus ?? '',
    c.summary ?? '',
  ];
  return `${cells.map(csvCell).join(',')}\n`;
}

/** RFC 4180: quote when needed, double the quotes inside. */
function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** "2026-09-04 12:28" in the restaurant's own clock. */
function localStamp(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'location';
}

