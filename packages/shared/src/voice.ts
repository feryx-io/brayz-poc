import { z } from 'zod';
import { E164 } from './ids.js';

/** ---- Voice nodes (Siphon-AI Compute Engine instances) ---- */
export const NodeStatus = z.enum(['ready', 'draining', 'drained', 'unhealthy']);
export type NodeStatus = z.infer<typeof NodeStatus>;

export const RegisterNodeInput = z.object({
  nodeId: z.string().min(1),
  region: z.string().min(1),
  environment: z.string().min(1),
  publicIp: z.string().nullish(),
  maxCalls: z.number().int().positive().default(100),
});
export type RegisterNodeInput = z.infer<typeof RegisterNodeInput>;

const count = z.number().int().nonnegative().nullish();
const percent = z.number().min(0).max(100).nullish();

/**
 * What a node's heartbeat says about its own health. Collected on the node by
 * `brayz-node-heartbeat` (modules/siphon-node) from SiphonAI's loopback
 * `/health`, `/ready` and `/metrics` and from the host — nothing outside the
 * node can reach those. Only the three probes are required: a metric the
 * daemon does not export (HEP off, say) arrives as null, never as a bad beat.
 */
export const NodeHealthSnapshot = z.object({
  version: z.string().max(64).nullish(),
  /** systemd reports siphon-ai active. */
  serviceActive: z.boolean(),
  /** GET /health answered 200: the process is up. */
  live: z.boolean(),
  /** GET /ready answered 200: SIP transports bound, registrations settled. */
  ready: z.boolean(),
  uptimeSeconds: count,
  dialogsActive: count,
  rtpPortPairsAllocated: count,
  rtpPortPairsCapacity: count,
  /** Null when HEP is off and the metric is absent. */
  hepCollectorUp: z.boolean().nullish(),
  /** Lifecycle webhooks waiting to reach the API — recordings stay unplayable meanwhile. */
  webhookSpoolDepth: count,
  recordingSpoolDepth: count,
  load1: z.number().nonnegative().nullish(),
  cpus: z.number().int().positive().nullish(),
  memUsedPct: percent,
  diskUsedPct: percent,
});
export type NodeHealthSnapshot = z.infer<typeof NodeHealthSnapshot>;

export const HeartbeatInput = z.object({
  activeCalls: z.number().int().nonnegative().default(0),
  status: NodeStatus.optional(),
  publicIp: z.string().nullish(),
  sipStatus: z.string().optional(),
  health: NodeHealthSnapshot.optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatInput>;

/** ---- Call lifecycle ---- */
export const CallEventType = z.enum([
  'call.invited',
  'call.answered',
  'call.media_started',
  'call.barge_in',
  'call.transferred',
  'call.completed',
  'call.failed',
  // The account's trial lapsed with no paid plan: the call was forwarded to
  // the restaurant or told it cannot be taken, not answered by the AI.
  'call.out_of_service',
]);
export type CallEventType = z.infer<typeof CallEventType>;

export const CallStatus = z.enum(['started', 'in_progress', 'transferred', 'completed', 'failed']);
export type CallStatus = z.infer<typeof CallStatus>;

/**
 * Create-or-find a call record. Called by the Orchestrator/Siphon-AI when a media
 * session begins. `toNumber` (the called restaurant line) resolves tenant/location.
 */
/**
 * A SiphonAI node's id as Brayz records it on a call: the node's configured
 * `[node].id` (e.g. `brayz-dev-siphon-001`, sent as `?node=` on its media URL),
 * or `ip:<address>` when a node did not name itself. Plain characters only —
 * it is grouped on and shown in the staff portal.
 */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const EnsureCallInput = z.object({
  callId: z.string().uuid().optional(),
  provider: z.string().default('twilio'),
  providerCallId: z.string().optional(),
  fromNumber: z.string().optional(),
  toNumber: E164,
  // Telemetry, so it never costs a call: a malformed id is dropped, not refused.
  nodeId: z.string().trim().regex(NODE_ID_PATTERN).optional().catch(undefined),
});
export type EnsureCallInput = z.infer<typeof EnsureCallInput>;

export const CallEventInput = z.object({
  eventType: CallEventType,
  occurredAt: z.string().datetime().optional(),
  payload: z.record(z.unknown()).default({}),
});
export type CallEventInput = z.infer<typeof CallEventInput>;

/**
 * One turn of the call's structured transcript. The Orchestrator appends these
 * as the conversation happens (caller finals from STT, agent replies from the
 * LLM); the dashboard reads them back through `GET /v1/calls/:id/transcript`.
 */
export const TranscriptTurn = z.object({
  speaker: z.enum(['caller', 'agent']),
  text: z.string().min(1),
  /** Offsets within the call's audio, when the provider reports them. */
  startedAtMs: z.number().int().nonnegative().optional(),
  endedAtMs: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  at: z.string().datetime().optional(),
});
export type TranscriptTurn = z.infer<typeof TranscriptTurn>;

/** Append-only: turns are added to the call's transcript, never replaced. */
export const AppendTranscriptInput = z.object({
  turns: z.array(TranscriptTurn).min(1).max(50),
});
export type AppendTranscriptInput = z.infer<typeof AppendTranscriptInput>;

/** Where a call's recording got to. `uploaded` means a URL exists to play. */
export const RecordingStatus = z.enum(['started', 'stopped', 'failed', 'uploaded']);
export type RecordingStatus = z.infer<typeof RecordingStatus>;

export const UpdateCallInput = z.object({
  status: CallStatus.optional(),
  summary: z.string().optional(),
  recordingStatus: RecordingStatus.optional(),
  recordingId: z.string().optional(),
  recordingUrl: z.string().url().optional(),
  endedAt: z.string().datetime().optional(),
});
export type UpdateCallInput = z.infer<typeof UpdateCallInput>;
