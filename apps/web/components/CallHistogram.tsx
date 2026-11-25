'use client';

import { useState, type KeyboardEvent } from 'react';
import type { HistogramBucket } from '@/lib/queries';
import { BUCKET_LABELS, bucketLabel, niceTicks, tickLabel } from '@/lib/histogram';

/** violet-600: clears 3:1 against the white card (checked with the dataviz palette validator). */
const BAR = '#7c3aed';
/** violet-500: the lift a bar gets on hover or keyboard focus. */
const BAR_ACTIVE = '#8b5cf6';
const PLOT_PX = 176;
const MAX_AXIS_LABELS = 6;

/**
 * Call volume per bucket, as columns.
 *
 * Hand-drawn, as the overview chart before it was: one series of at most a
 * couple of hundred numbers does not justify a charting library in every
 * browser. What a library would bring is here on purpose — a hairline grid on
 * round ticks, a tooltip per bar on hover and on keyboard focus (arrow keys),
 * and a table view, so no number is reachable only by hovering.
 */
export function CallHistogram({
  points,
  bucket,
  dimmed = false,
}: {
  points: Array<{ start: string; calls: number }>;
  bucket: HistogramBucket;
  /** The previous range's chart, held while the next one loads. */
  dimmed?: boolean;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);

  const peak = points.reduce((m, p) => Math.max(m, p.calls), 0);
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1] || 1;
  const labelEvery = Math.max(1, Math.ceil(points.length / MAX_AXIS_LABELS));
  const shown = active !== null ? points[active] : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!points.length) return;
    const last = points.length - 1;
    const at = active ?? -1;
    const next =
      e.key === 'ArrowRight' ? Math.min(last, at + 1)
      : e.key === 'ArrowLeft' ? Math.max(0, at < 0 ? last : at - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
  };

  const toggle = (
    <button
      type="button"
      onClick={() => setAsTable((v) => !v)}
      className="mt-3 text-xs font-medium text-violet-700 hover:text-violet-600"
    >
      {asTable ? 'Show as chart' : 'Show as table'}
    </button>
  );

  if (asTable) {
    return (
      <div className={dimmed ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
        <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">{BUCKET_LABELS[bucket]}</th>
                <th className="px-3 py-2 text-right font-medium">Calls</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {points.map((p) => (
                <tr key={p.start}>
                  <td className="px-3 py-1.5 text-slate-700">{bucketLabel(p.start, bucket)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-slate-900">{p.calls.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {toggle}
      </div>
    );
  }

  return (
    <div className={dimmed ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <div className="flex">
        {/* Y axis: round ticks, recessive. */}
        <div className="relative mr-2 w-10 shrink-0 text-right text-[11px] tabular-nums text-slate-500" style={{ height: PLOT_PX }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
              {t.toLocaleString()}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Hairline grid, solid, one step off the surface. */}
          <div className="pointer-events-none absolute inset-x-0 top-0" style={{ height: PLOT_PX }} aria-hidden>
            {ticks.map((t) => (
              <div key={t} className="absolute inset-x-0 border-t border-slate-200" style={{ bottom: `${(t / top) * 100}%` }} />
            ))}
          </div>

          <div
            role="group"
            tabIndex={0}
            aria-label={`Calls per ${bucket}. Use the arrow keys to read each ${bucket}, or switch to the table.`}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
            onPointerLeave={() => setActive(null)}
            className="relative flex items-end rounded outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
            style={{ height: PLOT_PX }}
          >
            {points.map((p, i) => (
              // The slot is the hit target: full height, gap included, so a
              // zero or a sliver is as easy to land on as the peak.
              <div
                key={p.start}
                className="flex h-full min-w-0 flex-1 items-end justify-center px-px"
                onPointerEnter={() => setActive(i)}
              >
                <div
                  className="w-full max-w-6 rounded-t-[4px] transition-colors"
                  style={{
                    height: p.calls ? `${Math.max((p.calls / top) * 100, 1.5)}%` : 0,
                    background: active === i ? BAR_ACTIVE : BAR,
                  }}
                />
              </div>
            ))}

            {shown && active !== null && (
              <div
                role="status"
                className="pointer-events-none absolute bottom-full z-10 mb-2 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-sm"
                style={{
                  left: `${((active + 0.5) / points.length) * 100}%`,
                  transform:
                    active < points.length * 0.15 ? 'translateX(-10%)'
                    : active > points.length * 0.85 ? 'translateX(-90%)'
                    : 'translateX(-50%)',
                }}
              >
                <p className="text-sm font-semibold tabular-nums text-slate-900">
                  {shown.calls.toLocaleString()} {shown.calls === 1 ? 'call' : 'calls'}
                </p>
                <p className="text-slate-500">{bucketLabel(shown.start, bucket)}</p>
              </div>
            )}
          </div>

          {/* X axis: a handful of labels, not one per bar. */}
          <div className="relative mt-1.5 h-4 text-[11px] text-slate-500" aria-hidden>
            {points.map((p, i) =>
              i % labelEvery === 0 ? (
                <span
                  key={p.start}
                  className="absolute -translate-x-1/2 whitespace-nowrap"
                  style={{ left: `${((i + 0.5) / points.length) * 100}%` }}
                >
                  {tickLabel(p.start, bucket)}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
      {toggle}
    </div>
  );
}
