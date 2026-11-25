import { z } from 'zod';

/**
 * SiphonAI WebSocket bridge protocol — v1 (the published contract in the
 * siphon-ai repo's docs/PROTOCOL.md). SiphonAI is the WS *client*; this
 * Orchestrator is the WS *server*. Text frames are JSON control; binary frames
 * are raw PCM16LE audio (no header), one 20 ms frame each.
 *
 * Keep these types matching that spec — changing them to fit our convenience is
 * how a real call silently breaks.
 */

/** `start` — first message SiphonAI sends on connect (§3.1). */
export const StartMessage = z
  .object({
    type: z.literal('start'),
    version: z.string().default('1'),
    // SiphonAI's internal call id (e.g. "siphon-7f3a9b21") — NOT a UUID, and
    // NOT the SIP Call-ID (that's in sip.call_id). We echo it on every reply.
    call_id: z.string(),
    seq: z.number().optional(),
    from: z.string().optional().default(''),
    to: z.string().optional().default(''),
    direction: z.enum(['inbound', 'outbound']).default('inbound'),
    audio: z
      .object({
        encoding: z.string().default('pcm16le'),
        sample_rate: z.number().default(8000),
        channels: z.number().default(1),
        frame_ms: z.number().default(20),
      })
      .default({}),
    sip: z
      .object({ call_id: z.string().optional(), headers: z.record(z.string()).optional() })
      .optional(),
  })
  // Additive fields (srtp, verstat, …) must pass through, not reject the call.
  .passthrough();
export type StartMessage = z.infer<typeof StartMessage>;

/**
 * Any other SiphonAI→server text frame (§3.2–§3.11). We validate the envelope
 * loosely and read fields per-type, so the many events we ignore
 * (speech_stopped, hold, resume, dtmf, mark, silence/dead_air/rtp_stats,
 * recording_*) never reject the connection.
 */
export const InboundEvent = z
  .object({
    type: z.string(),
    call_id: z.string().optional(),
    seq: z.number().optional(),
    // Named rather than left to passthrough because we act on them: the
    // recording lifecycle (§3.11) and the reason on stop/error (§3.9).
    recording_id: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type InboundEvent = z.infer<typeof InboundEvent>;

/** `stop` reason values (§3.9). */
export type StopReason =
  | 'caller_hangup'
  | 'server_hangup'
  | 'transfer'
  | 'ws_disconnect'
  | 'error';

/**
 * Server→SiphonAI control, as the engine emits it — WITHOUT call_id. The media
 * session stamps the connection's call_id on the wire (§4: every server message
 * MUST echo call_id; MUST NOT include seq).
 */
export type OutboundControl =
  | { type: 'clear' } // §4.1 barge-in: drop pending playout
  | { type: 'mark'; name: string } // §4.2
  | { type: 'hangup'; cause?: 'normal' | 'rejected' | 'busy' | 'not_acceptable' } // §4.3
  | { type: 'transfer'; target: string; replaces_call_id?: string } // §4.4 (target is a sip: URI)
  | { type: 'mute' } // §4.6
  | { type: 'unmute' };

/** Conversation state machine (implementation plan §7.2). */
export type CallState =
  | 'initializing'
  | 'loading_context'
  | 'greeting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'collecting_message'
  | 'collecting_order'
  | 'transferring'
  | 'completed'
  | 'failed';
