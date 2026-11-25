/**
 * Carrier abstraction (CLAUDE.md rule #2). Twilio is the first implementation,
 * not the platform model. Carrier-specific webhooks/events are normalized into
 * `NormalizedCarrierCallEvent` before they reach the rest of the system.
 */

export type NormalizedCarrierEventType =
  | 'call.invited'
  | 'call.answered'
  | 'call.media_started'
  | 'call.transferred'
  | 'call.completed'
  | 'call.failed';

export interface NormalizedCarrierCallEvent {
  type: NormalizedCarrierEventType;
  provider: string;
  providerCallId: string;
  from?: string;
  to?: string;
  occurredAt: string;
  /** Carrier-specific fields preserved for debugging, never used in business logic. */
  raw: Record<string, unknown>;
}

export interface TransferRequest {
  providerCallId: string;
  target: string; // E.164
}

/** A PSTN/SIP carrier behind which Twilio (and later others) sit. */
export interface CarrierProvider {
  readonly name: string;
  /** Normalize a raw inbound webhook/event payload into a canonical event. */
  normalizeEvent(raw: Record<string, unknown>): NormalizedCarrierCallEvent;
  /** Initiate a transfer/redirect of an active call to a staff number. */
  transfer(req: TransferRequest): Promise<void>;
  /** Hang up an active call. */
  hangup(providerCallId: string): Promise<void>;
}

export { TwilioCarrierProvider } from './twilio.js';
export {
  CarrierNotConfiguredError,
  TwilioNumberProvisioner,
  getTwilioClient,
} from './numbers.js';
export type {
  NumberProvisioner,
  NumberSearchQuery,
  AvailableNumber,
  ProvisionedNumber,
  TwilioCreds,
  TwilioLike,
} from './numbers.js';
export {
  SMS_STATUS_RANK,
  TwilioSmsSender,
  normalizeTwilioInboundSms,
  normalizeTwilioSmsStatus,
  validTwilioSignature,
} from './notifications.js';
export type {
  NormalizedInboundSms,
  NormalizedSmsStatus,
  NotificationSender,
  SmsDeliveryStatus,
  SmsMessage,
} from './notifications.js';
