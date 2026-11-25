import type { CallEventType, TranscriptTurn } from '@brayz/shared';

/**
 * How the Orchestrator persists call state. It goes through the Brayz API (rule
 * #5: the Orchestrator reaches data through the API, never raw tables). Injectable
 * so the media server can be tested without a running API.
 */
/**
 * Whether the AI should take the call, from the API's answer to ensureCall. An
 * account whose free trial lapsed with no paid plan is out of service: the call
 * goes to `forwardTo` (the restaurant's own phone, as a SIP URI) or the caller
 * is told it cannot be taken. Absent from an older API — read as in service.
 */
export interface CallService {
  inService: boolean;
  reason?: string | null;
  forwardTo?: string | null;
}

export interface EnsuredCall {
  id: string;
  tenantId: string;
  locationId: string;
  service?: CallService;
}

export interface CallPersistence {
  ensureCall(input: {
    callId?: string;
    fromNumber?: string;
    toNumber: string;
    nodeId?: string;
    providerCallId?: string;
  }): Promise<EnsuredCall | null>;
  postEvent(callId: string, eventType: CallEventType): Promise<void>;
  appendTranscript(callId: string, turns: TranscriptTurn[]): Promise<void>;
  /** Record the call's recording lifecycle (SiphonAI `recording_*`, protocol §3.11). */
  setRecording(callId: string, patch: { recordingId?: string; recordingStatus: string }): Promise<void>;
  completeCall(callId: string, patch?: { summary?: string | null }): Promise<void>;
}

/** Talks to the Brayz API using the node shared secret. Best-effort (logs, never throws). */
export class HttpCallPersistence implements CallPersistence {
  constructor(
    private readonly baseUrl: string,
    private readonly nodeSecret: string,
    private readonly log: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  private headers(): Record<string, string> {
    return { 'content-type': 'application/json', 'x-brayz-node-secret': this.nodeSecret };
  }

  async ensureCall(input: {
    callId?: string;
    fromNumber?: string;
    toNumber: string;
    nodeId?: string;
    providerCallId?: string;
  }): Promise<{ id: string; tenantId: string; locationId: string } | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/calls`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        this.log.warn({ status: res.status }, 'ensureCall failed');
        return null;
      }
      return (await res.json()) as { id: string; tenantId: string; locationId: string };
    } catch (err) {
      this.log.warn({ err }, 'ensureCall error');
      return null;
    }
  }

  async postEvent(callId: string, eventType: CallEventType): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/calls/${callId}/events`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ eventType }),
      });
    } catch (err) {
      this.log.warn({ err, eventType }, 'postEvent error');
    }
  }

  async appendTranscript(callId: string, turns: TranscriptTurn[]): Promise<void> {
    if (!turns.length) return;
    try {
      await fetch(`${this.baseUrl}/v1/calls/${callId}/transcript/turns`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ turns }),
      });
    } catch (err) {
      this.log.warn({ err, callId }, 'appendTranscript error');
    }
  }

  async setRecording(
    callId: string,
    patch: { recordingId?: string; recordingStatus: string },
  ): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/calls/${callId}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify(patch),
      });
    } catch (err) {
      this.log.warn({ err, callId }, 'setRecording error');
    }
  }

  async completeCall(callId: string, patch?: { summary?: string | null }): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/v1/calls/${callId}`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({
          status: 'completed',
          endedAt: new Date().toISOString(),
          ...(patch?.summary ? { summary: patch.summary } : {}),
        }),
      });
    } catch (err) {
      this.log.warn({ err }, 'completeCall error');
    }
  }
}
