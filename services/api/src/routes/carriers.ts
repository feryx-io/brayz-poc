import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import {
  SMS_STATUS_RANK,
  TwilioCarrierProvider,
  normalizeTwilioInboundSms,
  normalizeTwilioSmsStatus,
  validTwilioSignature,
  type SmsDeliveryStatus,
} from '@brayz/carriers';
import { loadConfig } from '@brayz/config';
import { prisma, writeAudit } from '@brayz/db';
import { SMS_OPT_IN_WORDS, SMS_OPT_OUT_WORDS } from '@brayz/shared';
import { SMS_STATUS_PATH } from '../lib/notifier.js';

/** Where Twilio posts texts sent to our numbers (set on the Messaging Service). */
export const SMS_INBOUND_PATH = '/v1/carriers/twilio/sms-inbound';

/** Did Twilio sign this request? The URL it signed is the one it called. */
function signedByTwilio(request: FastifyRequest): boolean {
  const cfg = loadConfig();
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol).split(',')[0]!.trim();
  const origin = cfg.API_PUBLIC_URL?.replace(/\/+$/, '') ?? `${proto}://${host}`;
  const signature = request.headers['x-twilio-signature'];
  return (
    !!cfg.TWILIO_AUTH_TOKEN &&
    validTwilioSignature(
      cfg.TWILIO_AUTH_TOKEN,
      `${origin}${request.url}`,
      (request.body ?? {}) as Record<string, unknown>,
      typeof signature === 'string' ? signature : undefined,
    )
  );
}

/**
 * Carrier webhooks. Twilio status callbacks are normalized into a
 * NormalizedCarrierCallEvent before touching anything else (CLAUDE.md rule #2),
 * then recorded against the matching call by providerCallId. Adding another
 * carrier means another provider + route, with no change downstream.
 *
 * TODO(phase-2): validate the X-Twilio-Signature header before trusting the body.
 */
const twilio = new TwilioCarrierProvider();

export async function carrierRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/carriers/twilio/status', async (request, reply) => {
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const event = twilio.normalizeEvent(raw);

    if (event.providerCallId) {
      const call = await prisma.call.findFirst({
        where: { providerCallId: event.providerCallId },
        select: { id: true },
      });
      if (call) {
        await prisma.callEvent.create({
          data: {
            callId: call.id,
            eventType: event.type,
            occurredAt: new Date(event.occurredAt),
            payload: { provider: event.provider, normalized: true },
          },
        });
      }
    }
    // Always 204 so the carrier doesn't retry on unmatched calls.
    return reply.status(204).send();
  });

  /**
   * What became of a text: Twilio's message status callback, which
   * textLocation asks for on every text it sends. Signed (X-Twilio-Signature)
   * and refused without a valid signature — it writes to notification rows.
   *
   * Callbacks arrive out of order and more than once (queued, sent, delivered),
   * so a status only ever moves forward: a late "sent" never overwrites
   * "delivered" (rule #7). An unknown message id is acknowledged, not retried —
   * a text sent before this existed, or from another tool on the account.
   */
  app.post(SMS_STATUS_PATH, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!signedByTwilio(request)) {
      request.log.warn({ path: request.url }, 'sms status callback with a bad signature');
      return reply.status(403).send({ error: { code: 'bad_signature', message: 'Invalid signature' } });
    }
    const status = normalizeTwilioSmsStatus(body);
    if (!status) return reply.status(204).send();
    const row = await prisma.notification.findUnique({
      where: { providerMessageId: status.providerMessageId },
      select: { id: true, deliveryStatus: true },
    });
    if (!row) return reply.status(204).send();
    const was = row.deliveryStatus as SmsDeliveryStatus | null;
    if (was && SMS_STATUS_RANK[status.status] < SMS_STATUS_RANK[was]) return reply.status(204).send();
    // A terminal state is never replaced by another terminal state either: the
    // first answer on whether it arrived stands.
    if (was && SMS_STATUS_RANK[was] === 2 && was !== status.status) return reply.status(204).send();
    await prisma.notification.update({
      where: { id: row.id },
      data: {
        deliveryStatus: status.status,
        deliveryErrorCode: status.errorCode,
        deliveryUpdatedAt: new Date(),
      },
    });
    if (status.status === 'undelivered' || status.status === 'failed') {
      request.log.warn(
        { notificationId: row.id, status: status.status, errorCode: status.errorCode },
        'text not delivered',
      );
    }
    return reply.status(204).send();
  });

  /**
   * A reply to one of our numbers: YES confirms text alerts, STOP ends them
   * (rule #6). Signed, like every Twilio webhook here.
   *
   * The number they replied to says which restaurant (tenant) this is — the
   * same way a call's dialled number does — and everything after that is read
   * inside that tenant (rule #1): the reply acts on this phone's consent at that
   * tenant's locations only. Carriers treat an opt-out as per sender number, so
   * one STOP ends alerts for every location of the restaurant, and one YES
   * confirms every location that is waiting on it.
   *
   * Twilio's Advanced Opt-Out already blocks texts after STOP and sends its own
   * STOP / HELP / START replies; this records the decision so the app knows it.
   */
  app.post(SMS_INBOUND_PATH, async (request, reply) => {
    const empty = () => reply.status(200).header('content-type', 'text/xml').send('<Response></Response>');
    if (!signedByTwilio(request)) {
      request.log.warn({ path: request.url }, 'inbound sms with a bad signature');
      return reply.status(403).send({ error: { code: 'bad_signature', message: 'Invalid signature' } });
    }
    const sms = normalizeTwilioInboundSms((request.body ?? {}) as Record<string, unknown>);
    if (!sms) return empty();
    const word = sms.text.trim().toLowerCase().replace(/[^a-z]/g, '');
    const intent =
      sms.providerKeyword ??
      (SMS_OPT_OUT_WORDS.includes(word) ? 'opt_out' : SMS_OPT_IN_WORDS.includes(word) ? 'opt_in' : null);
    if (intent !== 'opt_in' && intent !== 'opt_out') return empty();

    const line = await prisma.phoneNumber.findFirst({
      where: { e164Number: sms.to, active: true },
      select: { tenantId: true },
    });
    if (!line) return empty();
    const tenantId = line.tenantId;

    // The newest record per location and purpose for this phone, inside this
    // tenant. A STOP ends every kind of text this restaurant sends that number
    // — restaurant alerts and a guest's order updates alike — since carriers
    // treat an opt-out as per sender.
    const records = await prisma.smsConsentRecord.findMany({
      where: { tenantId, phone: sms.from },
      orderBy: { createdAt: 'desc' },
    });
    const latestByLocation = new Map<string, (typeof records)[number]>();
    for (const r of records) {
      const key = `${r.locationId}:${r.purpose}`;
      if (!latestByLocation.has(key)) latestByLocation.set(key, r);
    }

    for (const latest of latestByLocation.values()) {
      // YES confirms a waiting grant, or undoes an opt-out made by text. It does
      // not revive alerts an owner turned off in the dashboard.
      // A guest's yes was given on the call; a YES text restores only what a
      // STOP by text ended.
      const act =
        intent === 'opt_in'
          ? (latest.action === 'granted' && latest.purpose === 'restaurant_alerts') ||
            (latest.action === 'revoked' && latest.source === 'sms_reply')
          : latest.action !== 'revoked';
      if (!act) continue;
      const action = intent === 'opt_in' ? 'confirmed' : 'revoked';
      const created = await prisma.smsConsentRecord.create({
        data: {
          tenantId,
          locationId: latest.locationId,
          phone: sms.from,
          purpose: latest.purpose,
          action,
          source: 'sms_reply',
          disclosureVersion: latest.disclosureVersion,
          disclosureText: latest.disclosureText,
          providerMessageId: sms.providerMessageId,
          replyText: sms.text.slice(0, 160),
        },
      });
      await writeAudit({
        tenantId,
        locationId: latest.locationId,
        actorId: null,
        action: 'consent.changed',
        targetType: 'sms_consent',
        targetId: created.id,
        metadata: { purpose: latest.purpose, action, source: 'sms_reply' },
      });
    }
    return empty();
  });
}
