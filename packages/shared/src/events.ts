import { z } from 'zod';

/**
 * Canonical Pub/Sub event envelope (CLAUDE.md). Every event across every topic
 * uses this shape so workers stay decoupled and idempotent on `event_id`.
 */
export const EventEnvelope = z.object({
  event_id: z.string().uuid(),
  event_type: z.string().min(1),
  occurred_at: z.string().datetime(),
  tenant_id: z.string().uuid(),
  location_id: z.string().uuid().nullable().optional(),
  call_id: z.string().uuid().nullable().optional(),
  source: z.string().min(1),
  schema_version: z.string().default('1.0'),
  data: z.record(z.unknown()).default({}),
});

export type EventEnvelope = z.infer<typeof EventEnvelope>;

/** Known event types. Keep in sync with docs; workers switch on these. */
export const EVENT_TYPES = [
  'call.started',
  'call.answered',
  'call.ended',
  'call.failed',
  'call.transcript.segment.created',
  'call.summary.requested',
  'call.summary.completed',
  'order.draft.created',
  'order.confirmed',
  'order.sent_to_restaurant',
  'order.status_changed',
  'notification.requested',
  'notification.sent',
  'notification.failed',
  'guest.memory.updated',
  'carrier.event.received',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** Pub/Sub topics. */
export const TOPICS = [
  'call-events',
  'order-events',
  'notification-events',
  'guest-events',
  'billing-events',
] as const;
export type Topic = (typeof TOPICS)[number];

export interface BuildEnvelopeInput {
  event_id: string;
  event_type: EventType | string;
  occurred_at: string;
  tenant_id: string;
  location_id?: string | null;
  call_id?: string | null;
  source: string;
  data?: Record<string, unknown>;
}

/**
 * Construct a validated envelope. Callers supply ids/timestamps (kept pure for
 * deterministic testing); use `crypto.randomUUID()` and `new Date().toISOString()`
 * at the call site.
 */
export function buildEnvelope(input: BuildEnvelopeInput): EventEnvelope {
  return EventEnvelope.parse({
    schema_version: '1.0',
    data: {},
    ...input,
  });
}
