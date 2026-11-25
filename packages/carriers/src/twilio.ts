import type {
  CarrierProvider,
  NormalizedCarrierCallEvent,
  NormalizedCarrierEventType,
  TransferRequest,
} from './index.js';

/**
 * Twilio adapter (MVP). For now this normalizes Twilio's call-status payloads;
 * live transfer/hangup via the Twilio REST API land in Phase 2. The rest of the
 * system only ever sees NormalizedCarrierCallEvent.
 */
const TWILIO_STATUS_MAP: Record<string, NormalizedCarrierEventType> = {
  initiated: 'call.invited',
  ringing: 'call.invited',
  'in-progress': 'call.answered',
  answered: 'call.answered',
  completed: 'call.completed',
  busy: 'call.failed',
  failed: 'call.failed',
  'no-answer': 'call.failed',
  canceled: 'call.failed',
};

export class TwilioCarrierProvider implements CarrierProvider {
  readonly name = 'twilio';

  constructor(
    private readonly opts: { accountSid?: string; authToken?: string; now?: () => string } = {},
  ) {}

  normalizeEvent(raw: Record<string, unknown>): NormalizedCarrierCallEvent {
    const status = String(raw.CallStatus ?? raw.callStatus ?? '').toLowerCase();
    const type = TWILIO_STATUS_MAP[status] ?? 'call.failed';
    return {
      type,
      provider: this.name,
      providerCallId: String(raw.CallSid ?? raw.callSid ?? ''),
      from: raw.From ? String(raw.From) : undefined,
      to: raw.To ? String(raw.To) : undefined,
      occurredAt: this.opts.now?.() ?? new Date().toISOString(),
      raw,
    };
  }

  async transfer(_req: TransferRequest): Promise<void> {
    // Phase 2: call Twilio REST API to redirect the live call.
    throw new Error('TwilioCarrierProvider.transfer not implemented until Phase 2');
  }

  async hangup(_providerCallId: string): Promise<void> {
    throw new Error('TwilioCarrierProvider.hangup not implemented until Phase 2');
  }
}
