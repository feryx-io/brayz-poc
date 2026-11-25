import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@brayz/config';
import { Prisma } from '@brayz/db';
import { HttpError } from '../lib/http.js';
import { processWebhook } from '../lib/webhooks.js';

/**
 * SiphonAI lifecycle webhooks (its `[webhooks]` sink — off-band, not the WS
 * bridge). Today we act on one event: `recording_uploaded`, which fires after
 * `call_end` once the node's background worker has pushed the recording to
 * object storage, and carries the URL to play it back from.
 *
 * Two properties this endpoint must have, both from SiphonAI's own contract:
 *
 * - **Authenticated.** Anything that can POST here can stamp an arbitrary URL
 *   onto a call record, which is what the dashboard would then hand a user as
 *   "the recording". Deliveries are HMAC-signed; an unsigned or wrong-signed
 *   body is rejected, and with no secret configured the endpoint refuses
 *   everything rather than trusting the network.
 * - **Idempotent** (rule #7). Delivery is at-least-once: retries and
 *   post-restart spool replays redeliver bodies we have already handled, so we
 *   dedupe on the delivery id SiphonAI keeps stable across both.
 */

/** Reject a signature older than this — a captured POST must not replay later. */
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/** How long an upload for a call we cannot find is retried before it is let go. */
const RECORDING_CORRELATION_WINDOW_MS = 15 * 60 * 1000;

export interface SiphonWebhookOptions {
  /** Overrides the configured secret (tests). */
  secret?: string;
}

export async function siphonWebhookRoutes(
  app: FastifyInstance,
  opts: SiphonWebhookOptions = {},
): Promise<void> {
  const secret = opts.secret ?? loadConfig().SIPHON_WEBHOOK_SECRET;

  // The signature covers the bytes as sent, so this route needs the raw body —
  // re-serializing a parsed object would not reproduce them. Registered inside
  // this plugin, so the rest of the API keeps the default JSON parser.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/v1/webhooks/siphon', async (request, reply) => {
    if (!secret) {
      request.log.warn('siphon webhook received but SIPHON_WEBHOOK_SECRET is unset');
      throw new HttpError(503, 'Webhook receiver is not configured', 'webhook_not_configured');
    }
    const raw = (request as { rawBody?: string }).rawBody ?? '';
    const signature = request.headers['x-siphonai-signature'];
    if (typeof signature !== 'string' || !verifySignature(raw, signature, secret)) {
      throw new HttpError(401, 'Bad webhook signature', 'bad_signature');
    }

    const eventId = request.headers['x-siphonai-event-id'];
    const body = request.body as { type?: string; call_id?: string } & Record<string, unknown>;
    const eventType = typeof body?.type === 'string' ? body.type : 'unknown';
    if (typeof eventId !== 'string' || !eventId) {
      throw new HttpError(400, 'Missing X-SiphonAI-Event-Id', 'missing_event_id');
    }

    const processed = await processWebhook({ source: 'siphon', eventId, eventType }, async (tx) => {
      if (eventType === 'recording_uploaded') {
        await handleRecordingUploaded(app, tx, body);
      } else {
        request.log.debug({ eventType }, 'siphon lifecycle event ignored');
      }
    });
    return reply.status(200).send({ ok: true, ...(!processed ? { duplicate: true } : {}) });
  });
}

async function handleRecordingUploaded(
  app: FastifyInstance,
  tx: Prisma.TransactionClient,
  body: Record<string, unknown>,
): Promise<void> {
  const url = typeof body.url === 'string' ? body.url : undefined;
  const recordingId = typeof body.recording_id === 'string' ? body.recording_id : undefined;
  const siphonCallId = typeof body.call_id === 'string' ? body.call_id : undefined;
  if (!url || (!recordingId && !siphonCallId)) {
    app.log.warn({ body }, 'recording_uploaded missing url or correlation id');
    return;
  }

  // Correlate on the recording id we stored from `recording_started` — one
  // recording per call, and its id is SiphonAI's call id. `providerCallId` is
  // the SIP Call-ID when SiphonAI reports one, so it is only a fallback.
  const call = await tx.call.findFirst({
    where: {
      OR: [
        ...(recordingId ? [{ recordingId }] : []),
        ...(siphonCallId ? [{ providerCallId: siphonCallId }] : []),
      ],
    },
    select: { id: true, tenantId: true, locationId: true },
    orderBy: { startedAt: 'desc' },
  });
  if (!call) {
    // The call row is written when the call starts and the upload lands after
    // it ends, so a miss is usually a race worth retrying. Only for a while,
    // though: a call we never recorded (a number we don't route, say) will not
    // appear, and an upload retried forever sits in SiphonAI's spool — which is
    // capped, and drops the newest delivery when full.
    const uploadedAt = typeof body.timestamp === 'string' ? Date.parse(body.timestamp) : NaN;
    if (Number.isFinite(uploadedAt) && Date.now() - uploadedAt < RECORDING_CORRELATION_WINDOW_MS) {
      throw new HttpError(503, 'Recording call is not available yet', 'recording_call_pending');
    }
    app.log.warn({ recordingId, siphonCallId }, 'recording_uploaded for a call we do not have');
    return;
  }

  await tx.call.update({
    where: { id: call.id, tenantId: call.tenantId },
    data: { recordingUrl: url, recordingStatus: 'uploaded', recordingId: recordingId ?? undefined },
  });
  // Rule #6: a recording becoming reachable is an auditable event on its own,
  // separately from someone later playing it.
  await tx.auditLog.create({
    data: {
      tenantId: call.tenantId,
      locationId: call.locationId,
      action: 'recording.stored',
      targetType: 'call',
      targetId: call.id,
      metadata: { sizeBytes: body.size_bytes ?? null } as Prisma.InputJsonValue,
    },
  });
}

/**
 * `X-SiphonAI-Signature: t=<unix>,v1=<hex>` — HMAC-SHA256 over `"<t>.<body>"`.
 * The timestamp is inside the signed string, so a captured POST cannot be
 * replayed once it falls outside the freshness window.
 */
function verifySignature(raw: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return i === -1 ? [kv.trim(), ''] : [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const ageMs = Date.now() - Number(t) * 1000;
  if (!Number.isFinite(ageMs) || Math.abs(ageMs) > MAX_SIGNATURE_AGE_MS) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(v1, 'hex');
  } catch {
    return false;
  }
  // Length must match before timingSafeEqual, which throws on a mismatch —
  // and the length itself is not a secret.
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}
