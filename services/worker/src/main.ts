import pino from 'pino';
import { loadConfig } from '@brayz/config';
import { EventEnvelope } from '@brayz/shared';

/**
 * Worker skeleton (Phase 0). Phase 1+ subscribes to Pub/Sub topics and processes
 * call summaries, transcripts, notifications, and guest-favorite recomputes.
 *
 * RULE (CLAUDE.md #7): workers are idempotent — Pub/Sub redelivers. Every handler
 * must dedupe on `event_id` / an external job id before doing work.
 */
const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL });

const seen = new Set<string>();

/** Process one event envelope. Returns false if it was a duplicate (no-op). */
export async function handleEvent(raw: unknown): Promise<boolean> {
  const envelope = EventEnvelope.parse(raw);
  if (seen.has(envelope.event_id)) {
    log.debug({ eventId: envelope.event_id }, 'duplicate event ignored');
    return false;
  }
  seen.add(envelope.event_id);

  // Phase 1+: switch on envelope.event_type and dispatch to handlers.
  log.info(
    { eventType: envelope.event_type, tenantId: envelope.tenant_id, callId: envelope.call_id },
    'event received',
  );
  return true;
}

function main() {
  log.info({ project: cfg.GCP_PROJECT_ID }, 'Worker started (Pub/Sub subscriptions land in Phase 1)');
  // Phase 1: create Pub/Sub subscriptions and pipe messages into handleEvent.
}

main();
