import { NodeHealthSnapshot } from '@brayz/shared';

/**
 * Whether a SiphonAI node is well, from its last heartbeat.
 *
 * Nothing outside a node can reach its /health, /ready or /metrics (loopback
 * only, and the API is on Cloud Run), so each node reports in every
 * HEARTBEAT_INTERVAL_SECONDS (`brayz-node-heartbeat`, modules/siphon-node) and
 * this judges the report. Pure, so the rules are tested without a clock or a
 * database. Order matters: down beats draining beats degraded.
 */

/** How often `brayz-node-heartbeat` reports (its systemd timer). */
export const HEARTBEAT_INTERVAL_SECONDS = 30;
/** Three missed beats and a node is down — one lost request is not an outage. */
export const NODE_DOWN_AFTER_SECONDS = 3 * HEARTBEAT_INTERVAL_SECONDS;

export type NodeHealthState = 'healthy' | 'degraded' | 'draining' | 'down';

export interface NodeAssessment {
  state: NodeHealthState;
  /** Plain sentences for the staff portal; empty when healthy. */
  reasons: string[];
}

/** The stored snapshot, or null when there is none or it no longer parses. */
export function readSnapshot(value: unknown): NodeHealthSnapshot | null {
  const parsed = NodeHealthSnapshot.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function assessNode(
  node: { status: string; lastSeenAt: Date; health: NodeHealthSnapshot | null },
  now: Date,
): NodeAssessment {
  const h = node.health;
  const silentFor = Math.max(0, Math.round((now.getTime() - node.lastSeenAt.getTime()) / 1000));

  const down: string[] = [];
  if (silentFor > NODE_DOWN_AFTER_SECONDS) down.push(`No heartbeat for ${duration(silentFor)}`);
  if (h && !h.serviceActive) down.push('The siphon-ai service is not running');
  else if (h && !h.live) down.push('siphon-ai is not answering /health');
  if (down.length) return { state: 'down', reasons: down };

  if (node.status === 'draining') {
    return { state: 'draining', reasons: ['Draining — finishing its calls, taking no new ones'] };
  }

  const degraded: string[] = [];
  if (h) {
    if (!h.ready) degraded.push('Not ready: SIP transports or registrations have not settled');
    if (h.hepCollectorUp === false) degraded.push('Cannot reach the Homer collector');
    if ((h.webhookSpoolDepth ?? 0) > 0) {
      degraded.push(
        `${plural(h.webhookSpoolDepth ?? 0, 'webhook')} waiting to reach the API — recordings stay unplayable until they do`,
      );
    }
    if ((h.recordingSpoolDepth ?? 0) > 0) {
      degraded.push(`${plural(h.recordingSpoolDepth ?? 0, 'recording')} waiting to upload`);
    }
    const { rtpPortPairsAllocated: used, rtpPortPairsCapacity: cap } = h;
    if (cap && used != null && used / cap >= 0.8) {
      degraded.push(`RTP ports ${Math.round((used / cap) * 100)}% allocated`);
    }
    if ((h.diskUsedPct ?? 0) >= 90) degraded.push(`Disk ${Math.round(h.diskUsedPct ?? 0)}% full`);
    if ((h.memUsedPct ?? 0) >= 90) degraded.push(`Memory ${Math.round(h.memUsedPct ?? 0)}% used`);
    if (h.load1 != null && h.cpus && h.load1 / h.cpus >= 1.5) {
      degraded.push(`CPU load ${h.load1} on ${plural(h.cpus, 'core')}`);
    }
  }
  return degraded.length ? { state: 'degraded', reasons: degraded } : { state: 'healthy', reasons: [] };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function duration(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 2 * 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 2 * 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}
