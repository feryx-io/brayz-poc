/**
 * Phone-number provisioning, behind a provider-agnostic interface (CLAUDE.md
 * rule #2). Twilio is the first implementation. Business logic talks to
 * `NumberProvisioner`, never the Twilio SDK directly.
 */
import twilio from 'twilio';

/** Raised when a carrier client is requested but credentials aren't configured. */
export class CarrierNotConfiguredError extends Error {
  constructor(message = 'Telephony provider is not configured') {
    super(message);
    this.name = 'CarrierNotConfiguredError';
  }
}

export interface NumberSearchQuery {
  /** 3-digit US area code, e.g. "518". */
  areaCode?: string;
  /** 2-letter US state, e.g. "NY". */
  region?: string;
  /** City/locality, e.g. "Albany". */
  locality?: string;
  /** Digits/letters the number should contain (Twilio pattern). */
  contains?: string;
  limit?: number;
}

export interface AvailableNumber {
  e164Number: string;
  friendlyName: string;
  locality?: string;
  region?: string;
  postalCode?: string;
}

export interface ProvisionedNumber {
  e164Number: string;
  /** Carrier's stable id for the number (Twilio IncomingPhoneNumber SID). */
  providerNumberId: string;
}

/** Search for and purchase phone numbers from a carrier. */
export interface NumberProvisioner {
  readonly name: string;
  searchAvailable(query: NumberSearchQuery): Promise<AvailableNumber[]>;
  /** Purchase the number and route it to Brayz (attach to the SIP trunk). */
  provision(e164Number: string): Promise<ProvisionedNumber>;
}

/**
 * Minimal structural shape of the Twilio client we use — lets tests inject a
 * fake without pulling the full SDK types.
 */
export interface TwilioLike {
  availablePhoneNumbers(country: string): {
    local: {
      list(opts: {
        areaCode?: number;
        inRegion?: string;
        inLocality?: string;
        contains?: string;
        voiceEnabled?: boolean;
        limit?: number;
      }): Promise<
        Array<{
          phoneNumber: string;
          friendlyName: string;
          locality?: string;
          region?: string;
          postalCode?: string;
        }>
      >;
    };
  };
  incomingPhoneNumbers: {
    create(opts: { phoneNumber: string; trunkSid?: string }): Promise<{ sid: string; phoneNumber: string }>;
  };
  /** Messaging API — present on the real client; optional so number-only fakes stay valid. */
  messages?: {
    create(opts: {
      to: string;
      body: string;
      from?: string;
      messagingServiceSid?: string;
      statusCallback?: string;
    }): Promise<{ sid: string }>;
  };
}

export interface TwilioCreds {
  accountSid?: string;
  authToken?: string;
  /** Elastic SIP Trunk to attach purchased numbers to (routes calls to Brayz). */
  trunkSid?: string;
}

/** Build a Twilio REST client, or throw if creds are missing. */
export function getTwilioClient(creds: TwilioCreds): TwilioLike {
  if (!creds.accountSid || !creds.authToken) {
    throw new CarrierNotConfiguredError('Twilio is not configured (set TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN)');
  }
  return twilio(creds.accountSid, creds.authToken) as unknown as TwilioLike;
}

export class TwilioNumberProvisioner implements NumberProvisioner {
  readonly name = 'twilio';
  private readonly client: TwilioLike;
  private readonly trunkSid?: string;

  /** Pass `client` to inject a fake (tests); otherwise built from `creds`. */
  constructor(opts: { creds?: TwilioCreds; client?: TwilioLike; trunkSid?: string }) {
    this.client = opts.client ?? getTwilioClient(opts.creds ?? {});
    this.trunkSid = opts.trunkSid ?? opts.creds?.trunkSid;
  }

  async searchAvailable(query: NumberSearchQuery): Promise<AvailableNumber[]> {
    const results = await this.client.availablePhoneNumbers('US').local.list({
      areaCode: query.areaCode ? Number(query.areaCode) : undefined,
      inRegion: query.region,
      inLocality: query.locality,
      contains: query.contains,
      voiceEnabled: true,
      limit: Math.min(query.limit ?? 20, 30),
    });
    return results.map((n) => ({
      e164Number: n.phoneNumber,
      friendlyName: n.friendlyName,
      locality: n.locality,
      region: n.region,
      postalCode: n.postalCode,
    }));
  }

  async provision(e164Number: string): Promise<ProvisionedNumber> {
    // Setting trunkSid at purchase attaches the number to the Elastic SIP Trunk
    // in one call, so inbound calls route to SiphonAI → Orchestrator immediately.
    // Omit it entirely when unconfigured (buys the number without trunk routing).
    const opts: { phoneNumber: string; trunkSid?: string } = { phoneNumber: e164Number };
    if (this.trunkSid) opts.trunkSid = this.trunkSid;
    const bought = await this.client.incomingPhoneNumbers.create(opts);
    return { e164Number: bought.phoneNumber, providerNumberId: bought.sid };
  }
}
