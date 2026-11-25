'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { formatMoney, useInsights, useLocations, type HistogramBucket, type Insights } from '@/lib/queries';
import {
  BUCKET_LABELS,
  HISTOGRAM_RANGES,
  bucketsFor,
  histogramWindow,
  type HistogramRange,
} from '@/lib/histogram';
import { CallHistogram } from '@/components/CallHistogram';
import { StatCard, statLabelClass } from '@/components/StatCard';
import { useAuth } from '@/lib/auth';

/**
 * What Brayz did for this restaurant — the answer to "what am I paying for?".
 *
 * The dashboard says what is happening right now; this says what happened over
 * a stretch of time. Days are cut in the restaurant's own timezone, because its
 * trading day is what the numbers are about.
 */
export default function InsightsPage() {
  const { activeLocationId } = useAuth();
  const locations = useLocations();
  const location = locations.data?.find((l) => l.id === activeLocationId) ?? locations.data?.[0];
  const tz = location?.timezone ?? 'UTC';

  const [range, setRange] = useState<HistogramRange>('30d');
  const [bucket, setBucket] = useState<HistogramBucket>('day');
  // Pinned per choice, so the query key is stable between renders.
  const [now, setNow] = useState(() => new Date());
  const span = useMemo(() => histogramWindow(range, bucket, now, tz), [range, bucket, now, tz]);
  const insights = useInsights(location?.id, { bucket, from: span.from, to: span.to, tz });
  const allowed = bucketsFor(range);
  const d = insights.data;

  const pickRange = (next: HistogramRange) => {
    setRange(next);
    if (!bucketsFor(next).includes(bucket)) setBucket(HISTOGRAM_RANGES[next].defaultBucket);
    setNow(new Date());
  };

  if (locations.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!location) return <p className="text-slate-500">No location found.</p>;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Insights</h1>
          <p className="mt-1 text-sm text-slate-500">
            {location.name} · {HISTOGRAM_RANGES[range].label.toLowerCase()}, in the restaurant&apos;s
            own time zone
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2 text-slate-600">
            <span className="sr-only">Range</span>
            <select
              value={range}
              onChange={(e) => pickRange(e.target.value as HistogramRange)}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5"
            >
              {(Object.keys(HISTOGRAM_RANGES) as HistogramRange[]).map((r) => (
                <option key={r} value={r}>
                  {HISTOGRAM_RANGES[r].label}
                </option>
              ))}
            </select>
          </label>
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="Group by">
            {(['hour', 'day', 'week', 'month'] as const).map((b) => (
              <button
                key={b}
                type="button"
                disabled={!allowed.includes(b)}
                aria-pressed={bucket === b}
                onClick={() => {
                  setBucket(b);
                  setNow(new Date());
                }}
                className={
                  'rounded-md px-2.5 py-1 ' +
                  (bucket === b
                    ? 'bg-brayz text-white'
                    : allowed.includes(b)
                      ? 'text-slate-600 hover:bg-slate-100'
                      : 'cursor-not-allowed text-slate-300')
                }
              >
                {BUCKET_LABELS[b]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {insights.isLoading && !d && <p className="text-slate-500">Loading…</p>}
      {insights.isError && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {(insights.error as Error).message}
        </p>
      )}

      {d && (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Calls answered" value={d.calls.answered.toLocaleString()} />
            <StatCard
              label="Calls that would have rung out"
              value={d.calls.wouldHaveRungOut.toLocaleString()}
              hint={
                d.calls.hoursKnown
                  ? `${d.calls.afterHours} outside opening hours, ${d.calls.whileAnotherCallWasLive} while another call was live`
                  : 'Set your opening hours to count after-hours calls'
              }
            />
            <StatCard label="Orders captured" value={d.orders.count.toLocaleString()} />
            <StatCard
              label="Order revenue"
              value={formatMoney(d.orders.revenueCents)}
              hint={d.orders.count ? `${formatMoney(d.orders.averageCents)} average` : undefined}
            />
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className={statLabelClass}>Calls per {bucket}</h2>
              <Link href="/app/calls" className="text-sm text-brayz hover:underline">
                Recordings and transcripts →
              </Link>
            </div>
            <CallHistogram
              points={d.series.map((p) => ({ start: p.start, calls: p.calls }))}
              bucket={bucket}
              dimmed={insights.isFetching}
            />
          </section>

          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Upsell revenue"
              value={formatMoney(d.upsell.revenueCents)}
              hint={`${d.upsell.items} add-on ${d.upsell.items === 1 ? 'line' : 'lines'} the AI offered`}
            />
            <StatCard
              label="Discounts given"
              value={formatMoney(d.orders.discountCents)}
              hint={`${d.loyalty.redemptions} loyalty ${d.loyalty.redemptions === 1 ? 'redemption' : 'redemptions'}`}
            />
            <StatCard
              label="Guests who ordered"
              value={d.guests.ordering.toLocaleString()}
              hint={`${d.guests.new} new, ${d.guests.returning} returning`}
            />
            <StatCard
              label="Points earned"
              value={d.loyalty.pointsEarned.toLocaleString()}
              hint={
                d.loyalty.birthdayBonuses || d.loyalty.winbackBonuses
                  ? `${d.loyalty.birthdayBonuses} birthday, ${d.loyalty.winbackBonuses} win-back`
                  : undefined
              }
            />
          </section>

          {d.orders.byFulfillment.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className={`mb-3 ${statLabelClass}`}>Pickup and delivery</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {d.orders.byFulfillment.map((f) => (
                  <li key={f.type} className="flex items-center justify-between py-2">
                    <span className="capitalize text-slate-700">{f.type}</span>
                    <span className="text-slate-500">
                      {f.count} {f.count === 1 ? 'order' : 'orders'} ·{' '}
                      <span className="tabular-nums">{formatMoney(f.revenueCents)}</span>
                    </span>
                  </li>
                ))}
                {d.orders.deliveryFeeCents > 0 && (
                  <li className="flex items-center justify-between py-2 text-slate-500">
                    <span>Delivery fees collected</span>
                    <span className="tabular-nums">{formatMoney(d.orders.deliveryFeeCents)}</span>
                  </li>
                )}
              </ul>
            </section>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className={`mb-3 ${statLabelClass}`}>Favourite items</h2>
              {d.items.length === 0 ? (
                <p className="text-sm text-slate-400">No orders in this range.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {d.items.map((item) => (
                    <li key={item.name} className="py-2">
                      <div className="flex items-center justify-between gap-4">
                        <span className="truncate text-slate-700">{item.name}</span>
                        <span className="whitespace-nowrap text-slate-500">
                          {item.quantity.toLocaleString()} ordered
                        </span>
                      </div>
                      {/* Which sauce the wings went out with, which dip beside
                          it — the part a kitchen orders stock on. A line per
                          group, because a sauce and a dip are two questions. */}
                      {item.optionGroups.map((group) => (
                        <p key={group.name} className="mt-0.5 text-xs text-slate-500">
                          <span className="font-medium text-slate-600">{group.name}:</span>{' '}
                          {group.options
                            .map((o) => `${o.quantity.toLocaleString()} ${o.name}`)
                            .join(' · ')}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className={`mb-3 ${statLabelClass}`}>Top guests</h2>
              {d.guests.top.length === 0 ? (
                <p className="text-sm text-slate-400">No guest orders in this range.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-sm">
                  {d.guests.top.map((g) => {
                    const detail = `${g.orders} ${g.orders === 1 ? 'order' : 'orders'} · ${formatMoney(g.spentCents)}`;
                    return (
                      <li key={g.id ?? g.name}>
                        {g.id ? (
                          // Straight to their profile, rather than leaving the
                          // owner to find the name again on the Guests screen.
                          <Link
                            href={`/app/guests?guest=${g.id}`}
                            className="flex items-center justify-between gap-4 py-2 hover:bg-slate-50"
                          >
                            <span className="truncate font-medium text-brayz">{g.name ?? 'Guest'}</span>
                            <span className="whitespace-nowrap text-slate-500">{detail}</span>
                          </Link>
                        ) : (
                          <div className="flex items-center justify-between gap-4 py-2">
                            <span className="truncate text-slate-700">{g.name ?? 'Guest'}</span>
                            <span className="whitespace-nowrap text-slate-500">{detail}</span>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
