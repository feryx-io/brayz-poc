'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  useAdminCallHistogram,
  useAdminLiveCalls,
  useAdminOverview,
  type AdminLiveNode,
  type HistogramBucket,
} from '@/lib/queries';
import {
  BUCKET_LABELS,
  HISTOGRAM_RANGES,
  bucketLabel,
  bucketsFor,
  histogramWindow,
  type HistogramRange,
} from '@/lib/histogram';
import { CallHistogram } from '@/components/CallHistogram';

/** How the platform is doing: live calls, usage, revenue, and the support queue. */
export default function AdminOverviewPage() {
  const overview = useAdminOverview();
  const d = overview.data;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Platform overview</h1>
        <p className="mt-1 text-sm text-slate-600">Every restaurant on Brayz, at a glance.</p>
      </header>

      <LiveCalls />

      {overview.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {overview.isError && <p className="text-sm text-red-600">Could not load the platform overview.</p>}

      {d && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Customers" value={d.customers.total} hint={`${d.locations.total} locations`} />
          <Stat label="Paying locations" value={d.locations.subscribed} hint={`of ${d.locations.total}`} />
          <Stat label="Monthly revenue" value={money(d.revenue.mrrCents)} hint="active, trialing, past due" />
          <Stat
            label="Open support"
            value={d.support.open + d.support.inProgress}
            hint={`${d.support.open} not yet picked up`}
            href="/admin/support"
          />
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Calls</h2>
        {d && (
          <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Today (UTC)" value={d.calls.today} />
            <Stat label="Last 7 days" value={d.calls.last7Days} />
            <Stat label="Last 30 days" value={d.calls.last30Days} />
            <Stat label="All time" value={d.calls.total} />
          </div>
        )}
        <CallHistory />
      </section>

      {d && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Revenue by plan</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 font-medium">Locations</th>
                  <th className="px-4 py-2 text-right font-medium">Monthly</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {Object.keys(d.revenue.byPlan).length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-4 text-slate-500">
                      Nobody is being billed yet.
                    </td>
                  </tr>
                )}
                {Object.entries(d.revenue.byPlan).map(([plan, v]) => (
                  <tr key={plan}>
                    <td className="px-4 py-2 capitalize text-slate-900">{plan}</td>
                    <td className="px-4 py-2 tabular-nums text-slate-700">{v.locations}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-900">{money(v.mrrCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            {Object.entries(d.revenue.byStatus).map(([status, n]) => (
              <span key={status} className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-600">
                {status.replace(/_/g, ' ')}: <span className="tabular-nums font-medium text-slate-900">{n}</span>
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Calls in progress right now, the one number this page leads with, and how
 * they sit across the SiphonAI nodes. Polled every five seconds.
 */
type AdminNodeHealth = NonNullable<AdminLiveNode['health']>;
type NodeHealthState = AdminNodeHealth['state'];

function LiveCalls() {
  const live = useAdminLiveCalls();
  const d = live.data;
  const named = d?.nodes.filter((n) => n.nodeId !== null).length ?? 0;
  // Nodes that are anything but healthy — down, draining, degraded, or silent.
  const attention = d?.nodes.filter((n) => n.nodeId !== null && n.health?.state !== 'healthy').length ?? 0;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-8">
        <div>
          <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-slate-500">
            <span className="relative flex h-2 w-2" aria-hidden>
              {d && !live.isError && (
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              )}
              <span className={'relative inline-flex h-2 w-2 rounded-full ' + (live.isError ? 'bg-slate-400' : 'bg-emerald-500')} />
            </span>
            {live.isError ? 'Live — not updating' : 'Live'} · active calls
          </p>
          <p className="mt-2 text-6xl font-semibold tracking-tight text-slate-900">{d ? d.active.toLocaleString() : '—'}</p>
          <p className="mt-1 text-xs text-slate-500">
            {d
              ? `Across ${named} voice ${named === 1 ? 'node' : 'nodes'} · as of ${new Date(d.asOf).toLocaleTimeString()}`
              : live.isError
                ? 'Could not load the live count.'
                : 'Loading…'}
          </p>
          {attention > 0 && (
            <p className="mt-2 text-xs font-medium text-amber-800">
              <span aria-hidden>! </span>
              {attention} voice {attention === 1 ? 'node needs' : 'nodes need'} attention — see its health.
            </p>
          )}
          {d && d.stale > 0 && (
            <p className="mt-3 max-w-sm text-xs text-amber-800">
              <span className="font-semibold">Not counted:</span> {d.stale} call{' '}
              {d.stale === 1 ? 'record is' : 'records are'} still open after {d.activeWindowMinutes / 60} hours. Their
              end was never recorded, so they are not live.
            </p>
          )}
        </div>

        {d && (
          <div className="min-w-[24rem] flex-1">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="pb-2 font-medium">Voice node</th>
                  <th className="pb-2 font-medium">Health</th>
                  <th className="pb-2 text-right font-medium">Active</th>
                  <th className="pb-2 text-right font-medium">Last 24 h</th>
                  <th className="pb-2 text-right font-medium">Last call</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.nodes.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-3 text-slate-500">
                      No voice node has reported in or taken a call in the last 7 days.
                    </td>
                  </tr>
                )}
                {d.nodes.map((n) => (
                  <NodeRow key={n.nodeId ?? '(none)'} node={n} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/** Status colours carry state only, and always travel with an icon and a word. */
const HEALTH_STYLE: Record<NodeHealthState, { label: string; icon: string; className: string }> = {
  healthy: { label: 'Healthy', icon: '✓', className: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  degraded: { label: 'Degraded', icon: '!', className: 'bg-amber-50 text-amber-900 ring-amber-200' },
  draining: { label: 'Draining', icon: '↓', className: 'bg-sky-50 text-sky-900 ring-sky-200' },
  down: { label: 'Down', icon: '✕', className: 'bg-red-50 text-red-800 ring-red-200' },
};

function HealthBadge({ health }: { health: AdminNodeHealth | null }) {
  const base = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset';
  if (!health) {
    return (
      <span className={`${base} bg-slate-50 text-slate-500 ring-slate-200`} title="This node has never sent a heartbeat">
        <span aria-hidden>–</span>Not reporting
      </span>
    );
  }
  const s = HEALTH_STYLE[health.state];
  return (
    <span className={`${base} ${s.className}`} title={health.reasons.join('\n') || 'Every check passes'}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

function NodeRow({ node }: { node: AdminLiveNode }) {
  const h = node.health;
  const snap = h?.snapshot;
  // A compact line of what the node says about itself; anything it did not
  // report is simply left out.
  const facts = [
    snap?.version ? `v${snap.version}` : null,
    snap?.uptimeSeconds != null ? `up ${uptime(snap.uptimeSeconds)}` : null,
    h ? `heartbeat ${ago(h.lastHeartbeatAt)}` : null,
    snap?.memUsedPct != null ? `mem ${Math.round(snap.memUsedPct)}%` : null,
    snap?.diskUsedPct != null ? `disk ${Math.round(snap.diskUsedPct)}%` : null,
    snap?.load1 != null && snap.cpus ? `load ${snap.load1} / ${snap.cpus} cores` : null,
    snap?.rtpPortPairsCapacity
      ? `RTP ${(snap.rtpPortPairsAllocated ?? 0).toLocaleString()} / ${snap.rtpPortPairsCapacity.toLocaleString()}`
      : null,
    h && h.reportedActiveCalls !== node.active ? `node reports ${h.reportedActiveCalls} active` : null,
  ].filter((f): f is string => f !== null);

  return (
    <tr className="align-top">
      <td className="py-2 pr-4">
        {node.nodeId ? (
          <span className="font-mono text-xs text-slate-900">{node.nodeId}</span>
        ) : (
          <span
            className="text-slate-500"
            title="Calls from before node ids were recorded, or from a bridge that did not name itself"
          >
            Unattributed
          </span>
        )}
        {facts.length > 0 && <p className="mt-0.5 text-xs text-slate-500">{facts.join(' · ')}</p>}
        {h && h.reasons.length > 0 && (
          <ul className="mt-1 space-y-0.5 text-xs text-slate-700">
            {h.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </td>
      <td className="py-2 pr-4">{node.nodeId ? <HealthBadge health={h} /> : <span className="text-slate-400">—</span>}</td>
      <td className="py-2 text-right font-semibold tabular-nums text-slate-900">{node.active}</td>
      <td className="py-2 text-right tabular-nums text-slate-700">{node.last24Hours}</td>
      <td className="py-2 text-right text-slate-500">{node.lastCallAt ? ago(node.lastCallAt) : '—'}</td>
    </tr>
  );
}

/** "3 h" — how long siphon-ai has been up. */
function uptime(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} min`;
  if (seconds < 2 * 86400) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

/** Call volume over a chosen range, every customer together, in the viewer's timezone. */
function CallHistory() {
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', []);
  const [range, setRange] = useState<HistogramRange>('30d');
  const [bucket, setBucket] = useState<HistogramBucket>('day');
  // Pinned per choice, so the query key is stable between renders.
  const [now, setNow] = useState(() => new Date());
  const span = useMemo(() => histogramWindow(range, bucket, now, tz), [range, bucket, now, tz]);
  const hist = useAdminCallHistogram({ bucket, from: span.from, to: span.to, tz });
  const allowed = bucketsFor(range);

  const pickRange = (next: HistogramRange) => {
    setRange(next);
    if (!bucketsFor(next).includes(bucket)) setBucket(HISTOGRAM_RANGES[next].defaultBucket);
    setNow(new Date());
  };
  const pickBucket = (next: HistogramBucket) => {
    setBucket(next);
    setNow(new Date());
  };

  const data = hist.data;
  const peak = data?.points.reduce<{ start: string; calls: number } | null>(
    (best, p) => (p.calls > (best?.calls ?? 0) ? p : best),
    null,
  );

  return (
    <div className="mt-4">
      {/* One filter row, above the chart it scopes. */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2 text-slate-600">
          <span className="sr-only">Range</span>
          <select
            value={range}
            onChange={(e) => pickRange(e.target.value as HistogramRange)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-slate-900"
          >
            {(Object.keys(HISTOGRAM_RANGES) as HistogramRange[]).map((r) => (
              <option key={r} value={r}>
                {HISTOGRAM_RANGES[r].label}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Group by">
          {(['hour', 'day', 'week', 'month'] as const).map((b) => (
            <button
              key={b}
              type="button"
              disabled={!allowed.includes(b)}
              aria-pressed={bucket === b}
              onClick={() => pickBucket(b)}
              className={
                'rounded-md px-3 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:text-slate-300 ' +
                (bucket === b ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')
              }
            >
              {BUCKET_LABELS[b]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Calls per {bucket}</h3>
            <p className="text-xs text-slate-500">
              {data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'call' : 'calls'} · ` : ''}
              {HISTOGRAM_RANGES[range].label.toLowerCase()} · every customer · times in {tz}
            </p>
          </div>
          {peak && (
            <p className="text-xs text-slate-500">
              Peak <span className="font-semibold tabular-nums text-slate-900">{peak.calls.toLocaleString()}</span> ·{' '}
              {bucketLabel(peak.start, bucket)}
            </p>
          )}
        </div>

        {hist.isError && <p className="text-sm text-red-600">Could not load call history.</p>}
        {!data && hist.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {data && <CallHistogram points={data.points} bucket={data.bucket} dimmed={hist.isPlaceholderData} />}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  href,
}: {
  label: string;
  value: number | string;
  hint?: string;
  href?: string;
}) {
  const inner = (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition hover:-translate-y-0.5">
      {inner}
    </Link>
  ) : (
    inner
  );
}

/** "3 min ago" — the live table refreshes every five seconds, so relative is enough. */
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
