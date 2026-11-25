import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * The type a number wears on a restaurant screen: a small capitalised label
 * with letter-spacing over a large figure with tight tracking. The dashboard
 * took it from the staff portal (#125); every other screen that shows a figure
 * uses these too, so a number looks the same wherever an owner meets it.
 */
export const statLabelClass = 'text-xs font-medium uppercase tracking-wider text-slate-500';
export const statValueClass = 'text-3xl font-semibold tracking-tight tabular-nums text-slate-900';

/**
 * One number on a card.
 *
 * `live` turns the label into the staff portal's live badge: a pulsing dot and
 * "Live · <label>", for a number about this second rather than a period. It
 * says "not updating" when the query behind it is failing, because a dot that
 * pulses over a stale number is a lie.
 */
export function StatCard({
  label,
  value,
  hint,
  href,
  live,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  href?: string;
  live?: 'on' | 'stale';
}) {
  const inner = (
    <div className="h-full rounded-xl border border-slate-200 bg-white p-5 transition group-hover:border-brayz group-hover:shadow-sm">
      {live ? (
        <p className={`flex items-center gap-2 ${statLabelClass}`}>
          <span className="relative flex h-2 w-2" aria-hidden>
            {live === 'on' && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
            )}
            <span
              className={
                'relative inline-flex h-2 w-2 rounded-full ' +
                (live === 'stale' ? 'bg-slate-400' : 'bg-emerald-500')
              }
            />
          </span>
          {live === 'stale' ? 'Live — not updating' : 'Live'} · {label}
        </p>
      ) : (
        <p className={statLabelClass}>{label}</p>
      )}
      <p className={`mt-2 ${statValueClass}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}
    </div>
  );
  // Only a card with somewhere to go looks clickable: a hover border on
  // something that does nothing is worse than no affordance.
  return href ? (
    <Link href={href} className="group block rounded-xl transition hover:-translate-y-0.5">
      {inner}
    </Link>
  ) : (
    inner
  );
}
