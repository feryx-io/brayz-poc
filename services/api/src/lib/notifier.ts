import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { TwilioSmsSender, type NotificationSender } from '@brayz/carriers';
import { loadConfig } from '@brayz/config';
import { prisma } from '@brayz/db';
import type { SmsConsentPurpose } from '@brayz/shared';
import { agreedForOrder, mayText } from './smsConsent.js';

/**
 * The SMS sender the API texts restaurants with, or null when there are no
 * Twilio credentials — in which case every notification is skipped, never
 * failed. Texts go out from the location's own number (`senderNumberFor`);
 * `TWILIO_SMS_FROM` / `TWILIO_MESSAGING_SERVICE_SID` are only the fallback for
 * a location without one. Built once per route module; tests inject a fake.
 */
export function buildNotifier(): NotificationSender | null {
  const cfg = loadConfig();
  if (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN) return null;
  return new TwilioSmsSender({
    creds: { accountSid: cfg.TWILIO_ACCOUNT_SID, authToken: cfg.TWILIO_AUTH_TOKEN },
    from: cfg.TWILIO_SMS_FROM || undefined,
    messagingServiceSid: cfg.TWILIO_MESSAGING_SERVICE_SID || undefined,
  });
}

/** Where the provider reports delivery. The route is in routes/carriers.ts. */
export const SMS_STATUS_PATH = '/v1/carriers/twilio/sms-status';

/**
 * The API's public origin as a provider reaches it: API_PUBLIC_URL when set,
 * else the request's own host and scheme (Cloud Run forwards the proto). Null
 * for a local host a provider could never call back, so no callback is asked
 * for rather than one that fails every time.
 */
export function publicOrigin(request: Pick<FastifyRequest, 'headers' | 'protocol'>): string | null {
  const configured = loadConfig().API_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '');
  const host = request.headers['x-forwarded-host'] ?? request.headers.host;
  if (typeof host !== 'string' || !host || /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(host)) return null;
  const proto = String(request.headers['x-forwarded-proto'] ?? request.protocol ?? 'https').split(',')[0]!.trim();
  return `${proto}://${host}`;
}

/**
 * The number a location's texts are sent from: its own active line with this
 * sender's carrier (the number the AI answers on), so the owner sees the text
 * come from their restaurant rather than from some other tenant's line. A
 * location with no such number leaves it to the sender's configured default.
 */
export async function senderNumberFor(locationId: string, notifier: NotificationSender): Promise<string | undefined> {
  const own = await prisma.phoneNumber.findFirst({
    where: { locationId, active: true, provider: notifier.name },
    orderBy: { createdAt: 'asc' },
    select: { e164Number: true },
  });
  return own?.e164Number;
}

/**
 * Text a location's alerts number — only with confirmed consent — from the
 * location's own line, and record the attempt as a Notification row.
 * Idempotent on `dedupeKey` (rule #7) and swallows every error: the thing being
 * reported — an order, a message — is already saved, and a text that fails
 * must not undo it. Returns whether the text went out.
 */
export async function textLocation(
  log: FastifyBaseLogger,
  notifier: NotificationSender | null,
  notice: {
    tenantId: string;
    locationId: string;
    dedupeKey: string;
    body: string;
    /** The request sending it, for the delivery callback's public URL (see publicOrigin). */
    request?: Pick<FastifyRequest, 'headers' | 'protocol'>;
    /**
     * Send without confirmed consent. Only for the text that asks for consent
     * itself — every alert goes through the consent check.
     */
    consentRequest?: true;
  },
): Promise<boolean> {
  if (!notifier) return false;
  try {
    const seen = await prisma.notification.findUnique({ where: { dedupeKey: notice.dedupeKey }, select: { status: true } });
    if (seen) return seen.status === 'sent';
    const loc = await prisma.location.findUnique({
      where: { id: notice.locationId },
      select: { notificationPhone: true },
    });
    // Only the alerts number, and only once its owner has agreed and replied
    // YES (rule #6). The main phone used to be the fallback; it is the line
    // callers ring, nobody consented to texts on it, and it is often the Brayz
    // number itself.
    const to = loc?.notificationPhone;
    if (!to) {
      log.warn({ locationId: notice.locationId, dedupeKey: notice.dedupeKey }, 'no alerts number for location');
      return false;
    }
    return await sendConsented(log, notifier, { ...notice, to, purpose: 'restaurant_alerts', audience: 'restaurant' });
  } catch (err) {
    log.warn({ err, dedupeKey: notice.dedupeKey }, 'notification skipped');
    return false;
  }
}

/**
 * Text a guest about their own order — only if they agreed on the call, for
 * that order (purpose guest_order_updates). Same idempotency and never-fail
 * posture as textLocation.
 */
export async function textGuest(
  log: FastifyBaseLogger,
  notifier: NotificationSender | null,
  notice: {
    tenantId: string;
    locationId: string;
    phone: string;
    /** The order the text is about; the guest's yes must have been for it. */
    orderId: string;
    dedupeKey: string;
    body: string;
    request?: Pick<FastifyRequest, 'headers' | 'protocol'>;
  },
): Promise<boolean> {
  if (!notifier) return false;
  try {
    const seen = await prisma.notification.findUnique({ where: { dedupeKey: notice.dedupeKey }, select: { status: true } });
    if (seen) return seen.status === 'sent';
    return await sendConsented(log, notifier, { ...notice, to: notice.phone, purpose: 'guest_order_updates', audience: 'guest' });
  } catch (err) {
    log.warn({ err, dedupeKey: notice.dedupeKey }, 'guest text skipped');
    return false;
  }
}

/** The consent check, the send, and the record, shared by every text. */
async function sendConsented(
  log: FastifyBaseLogger,
  notifier: NotificationSender,
  notice: {
    tenantId: string;
    locationId: string;
    to: string;
    dedupeKey: string;
    body: string;
    purpose: SmsConsentPurpose;
    audience: 'restaurant' | 'guest';
    /** A guest text: consent must name this order too. */
    orderId?: string;
    request?: Pick<FastifyRequest, 'headers' | 'protocol'>;
    consentRequest?: true;
  },
): Promise<boolean> {
  const base = {
    tenantId: notice.tenantId,
    locationId: notice.locationId,
    channel: 'sms',
    audience: notice.audience,
    recipient: notice.to,
    body: notice.body,
    dedupeKey: notice.dedupeKey,
  };
  const consented =
    notice.consentRequest ||
    ((await mayText(notice.tenantId, notice.locationId, notice.to, notice.purpose)) &&
      (!notice.orderId || (await agreedForOrder(notice.tenantId, notice.locationId, notice.to, notice.orderId))));
  if (!consented) {
    log.info({ locationId: notice.locationId, dedupeKey: notice.dedupeKey, purpose: notice.purpose }, 'text skipped: no confirmed consent');
    // Recorded, so the dashboard can say texts are off rather than silent.
    await prisma.notification.create({ data: { ...base, status: 'skipped_no_consent' } }).catch(() => {});
    return false;
  }
  let sent = false;
  let providerMessageId: string | null = null;
  try {
    const from = await senderNumberFor(notice.locationId, notifier);
    const origin = notice.request ? publicOrigin(notice.request) : null;
    const res = await notifier.sendSms({
      to: notice.to,
      from,
      body: notice.body,
      ...(origin ? { statusCallback: `${origin}${SMS_STATUS_PATH}` } : {}),
    });
    providerMessageId = res.providerMessageId || null;
    sent = true;
  } catch (err) {
    log.warn({ err, dedupeKey: notice.dedupeKey, to: notice.to }, 'notification send failed');
  }
  const row = { ...base, status: sent ? 'sent' : 'failed', sentAt: sent ? new Date() : null };
  await prisma.notification
    .create({ data: { ...row, providerMessageId } })
    // A provider id already on another row (a provider that reuses ids, or a
    // fake one) must not cost the text its record: keep the row, lose only
    // the delivery report.
    .catch(() => (providerMessageId ? prisma.notification.create({ data: row }) : undefined))
    .catch(() => {});
  return sent;
}
