'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { useTenantTrial } from '@/lib/queries';

/**
 * The account's free trial, at the top of every screen: how long is left and,
 * once it has lapsed with no plan, that Brayz has stopped answering. Nothing
 * for an account that pays, or one from before trials.
 */
export function TrialBanner() {
  const { canManage } = useAuth();
  const q = useTenantTrial();
  const d = q.data;
  if (!d?.trial || d.converted) return null;

  const ends = new Date(d.trial.endsAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  const cta = canManage && (
    <Link
      href="/app/settings"
      className="shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
    >
      Choose a plan
    </Link>
  );

  if (d.trial.active) {
    const soon = d.trial.daysLeft <= 7;
    return (
      <div
        className={
          'mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm ' +
          (soon ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-violet-200 bg-violet-50 text-violet-950')
        }
      >
        <p>
          <span className="font-semibold">
            Free Pro trial — {d.trial.daysLeft} {d.trial.daysLeft === 1 ? 'day' : 'days'} left.
          </span>{' '}
          Every Pro feature is on until {ends}. Choose a plan any time; the days you have left still count.
        </p>
        {cta}
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-950"
    >
      <p>
        <span className="font-semibold">Your free trial ended on {ends}.</span> Brayz is no longer answering your
        calls: they ring through to your restaurant if it has a transfer number set, and otherwise callers hear
        that the call can’t be taken. Choose a plan to turn Brayz back on.
      </p>
      {cta}
    </div>
  );
}
