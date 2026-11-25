import { z } from 'zod';

/**
 * Consent to receive texts (CLAUDE.md rule #6: consent is enforced in code).
 *
 * Carriers require that everyone Brayz texts agreed to it, knowingly, and can
 * stop. The words a person agreed to are part of the record, so they are
 * versioned: change the wording, bump the version, and every record still says
 * exactly what that person saw.
 */

/**
 * What the texts are for. restaurant_alerts: to the restaurant's owner or staff
 * about orders and messages. guest_order_updates: to a caller about the order
 * they just placed, agreed to out loud on the call.
 */
export const SmsConsentPurpose = z.enum(['restaurant_alerts', 'guest_order_updates']);
export type SmsConsentPurpose = z.infer<typeof SmsConsentPurpose>;

/** granted (checked the box) → confirmed (replied YES) → revoked (STOP, or turned off). */
export const SmsConsentAction = z.enum(['granted', 'confirmed', 'revoked']);
export type SmsConsentAction = z.infer<typeof SmsConsentAction>;

export const SmsConsentSource = z.enum(['dashboard', 'sms_reply', 'voice_call']);
export type SmsConsentSource = z.infer<typeof SmsConsentSource>;

/** Where a location's text alerts stand for its alerts number. */
export type SmsConsentState = 'none' | 'pending' | 'on' | 'off';

export const RESTAURANT_ALERTS_DISCLOSURE_VERSION = 'restaurant-alerts-v1';

/** The opt-in wording shown beside the unchecked box, for one restaurant. */
export function restaurantAlertsDisclosure(restaurantName: string): string {
  return (
    `I agree to receive order and message alert texts from Brayz for ${restaurantName} at this number. ` +
    'Message frequency varies with orders and calls. Msg & data rates may apply. ' +
    'Reply STOP to opt out, HELP for help. Consent is not a condition of purchase.'
  );
}

/** The text that asks the number's owner to confirm. Nothing else is sent until they reply YES. */
export function restaurantAlertsConfirmationSms(restaurantName: string): string {
  return (
    `Brayz: Reply YES to get order and message alerts for ${restaurantName}. ` +
    'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'
  );
}

/** Words that confirm an opt-in, as carriers and Twilio's defaults treat them. */
export const SMS_OPT_IN_WORDS = ['yes', 'y', 'start', 'unstop', 'subscribe'];
/** Words that end one, per CTIA and Twilio's default opt-out handling. */
export const SMS_OPT_OUT_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke'];

export const GrantSmsConsentInput = z.object({
  /** E.164; the alerts number. */
  phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164, like +15185551234'),
  /** The box. Anything but true is not consent. */
  agreed: z.literal(true),
});
export type GrantSmsConsentInput = z.infer<typeof GrantSmsConsentInput>;

export const GUEST_ORDER_UPDATES_DISCLOSURE_VERSION = 'guest-order-updates-v2';

/**
 * Where people reach us about texts. Carriers check that the HELP reply, the
 * terms and the privacy policy all give the same monitored contact.
 */
export const SMS_SUPPORT_EMAIL = 'support@brayz.ai';

/**
 * How a guest text names its sender. The restaurant is who the caller knows;
 * Brayz is the brand registered for the texts, and carriers expect it named.
 */
function guestSender(restaurantName: string): string {
  return `${restaurantName} via Brayz`;
}

/**
 * The question the bot asks after an order is placed, spoken by the engine word
 * for word (never paraphrased by the model), so the disclosure a caller agrees
 * to is always the one on record. v2 names Brayz as the sender.
 */
export function guestOrderTextsOffer(restaurantName: string): string {
  return (
    `Would you like a text when your order is ready? ${restaurantName} will text the number you're calling from ` +
    'about this order, through Brayz. Message and data rates may apply, and you can reply STOP anytime.'
  );
}

/** Sent right after a caller agrees: the written record of what they agreed to, and how to stop. */
export function guestOrderTextsConfirmationSms(restaurantName: string, orderCode: string): string {
  return (
    `${guestSender(restaurantName)}: You'll get a text when order #${orderCode} is ready. ` +
    'Msg & data rates may apply. Reply STOP to opt out, HELP for help.'
  );
}

/** The update itself, when the kitchen marks the order ready. */
export function guestOrderReadySms(restaurantName: string, orderCode: string, delivery: boolean): string {
  return delivery
    ? `${guestSender(restaurantName)}: Your order #${orderCode} is ready and heading out for delivery. Reply STOP to opt out.`
    : `${guestSender(restaurantName)}: Your order #${orderCode} is ready for pickup. Reply STOP to opt out.`;
}

/**
 * The keyword replies. Twilio sends these (the Messaging Service's Advanced
 * Opt-Out settings), not our code, and one set covers both kinds of text, so
 * they are written for both. The public opt-in page and the campaign
 * registration quote these constants; the Messaging Service must match them
 * (docs/operations/sms-consent.md).
 */
export const SMS_HELP_REPLY =
  'Brayz: texts about restaurant orders and messages. Msg frequency varies. Msg & data rates may apply. ' +
  `Reply STOP to opt out. Help: ${SMS_SUPPORT_EMAIL}`;
export const SMS_OPT_OUT_REPLY =
  "Brayz: You're unsubscribed and will get no more texts from this number. Reply START to resubscribe.";
export const SMS_OPT_IN_REPLY =
  "Brayz: You're subscribed to texts about restaurant orders and messages. Msg frequency varies. " +
  'Msg & data rates may apply. Reply STOP to opt out, HELP for help.';
