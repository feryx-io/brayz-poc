import { createHmac, timingSafeEqual } from 'node:crypto';
/**
 * Outbound notifications (SMS first), behind a provider-agnostic interface
 * (CLAUDE.md rule #2). Twilio is the first implementation; business logic talks
 * to `NotificationSender`, never the Twilio SDK directly. SMS is distinct from
 * voice (CarrierProvider) even though both ride the same Twilio account.
 */
import { CarrierNotConfiguredError, getTwilioClient, type TwilioCreds, type TwilioLike } from './numbers.js';

export interface SmsMessage {
  /** Destination phone, E.164. */
  to: string;
  body: string;
  /**
   * Sender phone, E.164 — a number this provider owns (a restaurant's own
   * line, so the owner sees the text come from their restaurant). Falls back
   * to the sender's configured default when omitted.
   */
  from?: string;
  /**
   * Where the provider should report what became of the message — delivered,
   * or undelivered and why. Without it "sent" only ever meant "the provider
   * accepted it": on 2026-09-14 every text Brayz had sent was undelivered
   * (unregistered 10DLC) while the app said sent.
   */
  statusCallback?: string;
}

/** Sends transactional notifications to a recipient. */
export interface NotificationSender {
  readonly name: string;
  sendSms(msg: SmsMessage): Promise<{ providerMessageId: string }>;
}

export class TwilioSmsSender implements NotificationSender {
  readonly name = 'twilio';
  private readonly client: TwilioLike;
  private readonly from?: string;
  private readonly messagingServiceSid?: string;

  /** Pass `client` to inject a fake (tests); otherwise built from `creds`. */
  constructor(opts: {
    creds?: TwilioCreds;
    client?: TwilioLike;
    /** E.164 sender number. Either this or `messagingServiceSid` is required. */
    from?: string;
    /** Twilio Messaging Service SID (preferred — handles sender pools/compliance). */
    messagingServiceSid?: string;
  }) {
    this.client = opts.client ?? getTwilioClient(opts.creds ?? {});
    this.from = opts.from;
    this.messagingServiceSid = opts.messagingServiceSid;
  }

  async sendSms(msg: SmsMessage): Promise<{ providerMessageId: string }> {
    if (!this.client.messages) {
      throw new CarrierNotConfiguredError('This Twilio client does not support messaging');
    }
    const from = msg.from ?? this.from;
    if (!from && !this.messagingServiceSid) {
      throw new CarrierNotConfiguredError(
        'No SMS sender: the location has no number of its own and neither TWILIO_SMS_FROM nor TWILIO_MESSAGING_SERVICE_SID is set',
      );
    }
    const opts: { to: string; body: string; from?: string; messagingServiceSid?: string; statusCallback?: string } = {
      to: msg.to,
      body: msg.body,
      ...(msg.statusCallback ? { statusCallback: msg.statusCallback } : {}),
    };
    // A Messaging Service handles sender selection and compliance (A2P
    // registration) for its pool; prefer it over any bare from, per-message
    // or default, since a number outside the pool would be refused.
    if (this.messagingServiceSid) opts.messagingServiceSid = this.messagingServiceSid;
    else opts.from = from;
    const res = await this.client.messages.create(opts);
    return { providerMessageId: res.sid };
  }
}

/** What became of a text, in Brayz's words rather than a vendor's. */
export interface NormalizedSmsStatus {
  providerMessageId: string;
  /** queued | sent | delivered | undelivered | failed */
  status: SmsDeliveryStatus;
  /** The provider's error code when it did not arrive, e.g. Twilio "30034". */
  errorCode: string | null;
}

export type SmsDeliveryStatus = 'queued' | 'sent' | 'delivered' | 'undelivered' | 'failed';

/** How far along a message is, so a late "sent" never overwrites "delivered". */
export const SMS_STATUS_RANK: Record<SmsDeliveryStatus, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  undelivered: 2,
  failed: 2,
};

/**
 * A Twilio message status callback (form fields) as a NormalizedSmsStatus, or
 * null for one without a message id or with a status Brayz does not track.
 * Twilio's accepted / scheduled / sending / receiving / read fold into the
 * nearest state Brayz keeps.
 */
export function normalizeTwilioSmsStatus(body: Record<string, unknown>): NormalizedSmsStatus | null {
  const sid = typeof body.MessageSid === 'string' ? body.MessageSid : typeof body.SmsSid === 'string' ? body.SmsSid : '';
  const raw = String(body.MessageStatus ?? body.SmsStatus ?? '').toLowerCase();
  if (!sid || !raw) return null;
  const status: SmsDeliveryStatus | null =
    raw === 'delivered' || raw === 'read'
      ? 'delivered'
      : raw === 'undelivered'
        ? 'undelivered'
        : raw === 'failed' || raw === 'canceled'
          ? 'failed'
          : raw === 'sent'
            ? 'sent'
            : raw === 'queued' || raw === 'accepted' || raw === 'scheduled' || raw === 'sending'
              ? 'queued'
              : null;
  if (!status) return null;
  const code = body.ErrorCode;
  return { providerMessageId: sid, status, errorCode: code != null && String(code) !== '' ? String(code) : null };
}

/**
 * Is this request really from Twilio? Twilio signs the full URL it called plus
 * every POST field (sorted by name, name and value concatenated) with the
 * account's auth token: HMAC-SHA1, base64, in X-Twilio-Signature.
 */
export function validTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  if (!signature || !authToken) return false;
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => `${k}${params[k] ?? ''}`)
      .join('');
  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A text someone sent to one of our numbers, in Brayz's words. */
export interface NormalizedInboundSms {
  providerMessageId: string;
  /** E.164, the person replying. */
  from: string;
  /** E.164, our number they replied to. */
  to: string;
  text: string;
  /**
   * What the provider itself decided the reply means, when it handles opt-out
   * keywords (Twilio Advanced Opt-Out sends OptOutType): opt_in | opt_out | help.
   */
  providerKeyword: 'opt_in' | 'opt_out' | 'help' | null;
}

/** A Twilio incoming-message webhook (form fields) as a NormalizedInboundSms, or null if it is not one. */
export function normalizeTwilioInboundSms(body: Record<string, unknown>): NormalizedInboundSms | null {
  const str = (k: string) => (typeof body[k] === 'string' ? (body[k] as string) : '');
  const sid = str('MessageSid') || str('SmsSid');
  const from = str('From');
  const to = str('To');
  if (!sid || !from || !to) return null;
  const kind = str('OptOutType').toUpperCase();
  return {
    providerMessageId: sid,
    from,
    to,
    text: str('Body'),
    providerKeyword: kind === 'START' ? 'opt_in' : kind === 'STOP' ? 'opt_out' : kind === 'HELP' ? 'help' : null,
  };
}
