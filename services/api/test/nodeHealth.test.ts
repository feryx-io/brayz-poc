import { describe, expect, it } from 'vitest';
import type { NodeHealthSnapshot } from '@brayz/shared';
import { assessNode, NODE_DOWN_AFTER_SECONDS, readSnapshot } from '../src/lib/nodeHealth.js';

const NOW = new Date('2026-09-11T15:00:00Z');
const secondsAgo = (s: number) => new Date(NOW.getTime() - s * 1000);

const WELL: NodeHealthSnapshot = {
  version: '0.51.1',
  serviceActive: true,
  live: true,
  ready: true,
  uptimeSeconds: 3600,
  dialogsActive: 0,
  rtpPortPairsAllocated: 2,
  rtpPortPairsCapacity: 5000,
  hepCollectorUp: true,
  webhookSpoolDepth: 0,
  recordingSpoolDepth: 0,
  load1: 0.1,
  cpus: 2,
  memUsedPct: 24,
  diskUsedPct: 15,
};

const assess = (health: NodeHealthSnapshot | null, over: { status?: string; seen?: number } = {}) =>
  assessNode({ status: over.status ?? 'ready', lastSeenAt: secondsAgo(over.seen ?? 10), health }, NOW);

describe('assessNode', () => {
  it('calls a node that reports well healthy', () => {
    expect(assess(WELL)).toEqual({ state: 'healthy', reasons: [] });
  });

  it('calls a node down after three missed beats, whatever its last report said', () => {
    expect(assess(WELL, { seen: NODE_DOWN_AFTER_SECONDS }).state).toBe('healthy');
    const late = assess(WELL, { seen: NODE_DOWN_AFTER_SECONDS + 1 });
    expect(late.state).toBe('down');
    expect(late.reasons[0]).toMatch(/No heartbeat for 91 s/);
    expect(assess(WELL, { seen: 3 * 3600 }).reasons[0]).toMatch(/3 h/);
  });

  it('calls a node down when the daemon itself is not up', () => {
    expect(assess({ ...WELL, serviceActive: false, live: false })).toEqual({
      state: 'down',
      reasons: ['The siphon-ai service is not running'],
    });
    expect(assess({ ...WELL, live: false }).reasons).toEqual(['siphon-ai is not answering /health']);
  });

  it('reports draining before anything merely degraded', () => {
    expect(assess({ ...WELL, ready: false }, { status: 'draining' }).state).toBe('draining');
    // …but down still wins over draining.
    expect(assess(WELL, { status: 'draining', seen: 600 }).state).toBe('down');
  });

  it('lists every reason a node is degraded', () => {
    const r = assess({
      ...WELL,
      ready: false,
      hepCollectorUp: false,
      webhookSpoolDepth: 3,
      recordingSpoolDepth: 1,
      rtpPortPairsAllocated: 4200,
      diskUsedPct: 93,
      memUsedPct: 91.4,
      load1: 3.2,
    });
    expect(r.state).toBe('degraded');
    expect(r.reasons).toEqual([
      'Not ready: SIP transports or registrations have not settled',
      'Cannot reach the Homer collector',
      '3 webhooks waiting to reach the API — recordings stay unplayable until they do',
      '1 recording waiting to upload',
      'RTP ports 84% allocated',
      'Disk 93% full',
      'Memory 91% used',
      'CPU load 3.2 on 2 cores',
    ]);
  });

  it('does not count HEP being off as a fault', () => {
    expect(assess({ ...WELL, hepCollectorUp: null }).state).toBe('healthy');
  });

  it('judges a node with no snapshot on its heartbeat alone', () => {
    expect(assess(null).state).toBe('healthy');
    expect(assess(null, { seen: 600 }).state).toBe('down');
  });

  it('ignores a stored snapshot that no longer parses rather than failing the page', () => {
    expect(readSnapshot({ serviceActive: 'yes' })).toBeNull();
    expect(readSnapshot(null)).toBeNull();
    expect(readSnapshot(WELL)).toEqual(WELL);
  });
});
