'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useAdminTrials, type AdminTrial, type AdminTrialFilter, type AdminTrialState } from '@/lib/queries';
import { ExtendTrialForm } from '@/components/ExtendTrialForm';

const FILTERS: Array<[AdminTrialFilter, string]> = [
  ['active', 'Active'],
  ['ending', 'Ending soon'],
  ['expired', 'Expired'],
  ['converted', 'Converted'],
  ['all', 'All'],
];

/** Status colours carry state only, and always travel with an icon and a word. */
const STATE: Record<AdminTrialState, { label: string; icon: string; pill: string; bar: string }> = {
  active: { label: 'Active', icon: '●', pill: 'bg-violet-50 text-violet-800 ring-violet-200', bar: 'bg-violet-500' },
  ending: { label: 'Ending soon', icon: '!', pill: 'bg-amber-50 text-amber-900 ring-amber-200', bar: 'bg-amber-500' },
  expired: { label: 'Expired', icon: '✕', pill: 'bg-red-50 text-red-800 ring-red-200', bar: 'bg-red-500' },
  converted: { label: 'Converted', icon: '✓', pill: 'bg-emerald-50 text-emerald-800 ring-emerald-200', bar: 'bg-emerald-500' },
};

/**
 * Every account's free trial and how it is going: how far through it is, how
 * far it has got setting Brayz up, what it has used, and — once it lapses —
 * how many calls it is turning away. Admins can extend one from here.
 */
export default function AdminTrialsPage() {
  const { platformRole } = useAuth();
  const [filter, setFilter] = useState<AdminTrialFilter>('active');
  const [extending, setExtending] = useState<string | null>(null);
  const trials = useAdminTrials(filter);
  const d = trials.data;
  const isAdmin = platformRole === 'admin';

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Free trials</h1>
        <p className="mt-1 text-sm text-slate-600">
          Every new account gets {d?.trialDays ?? 30} days of Pro. When a trial ends without a plan, Brayz stops
          answering that restaurant’s calls.
        </p>
      </header>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Filter trials">
        {FILTERS.map(([value, label]) => {
          const count = value === 'all' ? undefined : value === 'active' ? (d ? d.counts.active + d.counts.ending : undefined) : d?.counts[value];
          return (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={
                'rounded-full border px-3 py-1 text-sm transition ' +
                (filter === value
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300')
              }
            >
              {label}
              {count !== undefined && <span className="ml-1.5 tabular-nums opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      {trials.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {trials.isError && <p className="text-sm text-red-600">Could not load trials.</p>}

      {d && (
        <div className={'overflow-x-auto rounded-xl border border-slate-200 bg-white ' + (trials.isPlaceholderData ? 'opacity-60' : '')}>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Restaurant</th>
                <th className="px-4 py-2.5 font-medium">Trial</th>
                <th className="px-4 py-2.5 font-medium">Setup</th>
                <th className="px-4 py-2.5 text-right font-medium">During trial</th>
                <th className="px-4 py-2.5 text-right font-medium">Turned away</th>
                {isAdmin && <th className="px-4 py-2.5" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {d.trials.length === 0 && (
                <tr>
                  <td colSpan={isAdmin ? 6 : 5} className="px-4 py-6 text-slate-500">
                    No trials here.
                  </td>
                </tr>
              )}
              {d.trials.map((t) => (
                <Fragment key={t.tenantId}>
                  <TrialRow trial={t} isAdmin={isAdmin} onExtend={() => setExtending(extending === t.tenantId ? null : t.tenantId)} />
                  {isAdmin && extending === t.tenantId && (
                    <tr className="bg-slate-50">
                      <td colSpan={6} className="px-4 py-3">
                        <ExtendTrialForm tenantId={t.tenantId} hasTrial onDone={() => setExtending(null)} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TrialRow({ trial: t, isAdmin, onExtend }: { trial: AdminTrial; isAdmin: boolean; onExtend: () => void }) {
  const s = STATE[t.state];
  const used = t.daysTotal > 0 ? Math.min(100, Math.round((t.daysUsed / t.daysTotal) * 100)) : 100;
  const ends = new Date(t.endsAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const when =
    t.state === 'converted'
      ? `Paying · trial ${t.daysLeft > 0 ? `ends ${ends}` : `ended ${ends}`}`
      : t.daysLeft > 0
        ? `${t.daysLeft} ${t.daysLeft === 1 ? 'day' : 'days'} left · ends ${ends}`
        : `Ended ${ends}`;

  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <Link href={`/admin/customers/${t.tenantId}`} className="font-medium text-slate-900 hover:text-violet-700">
          {t.name}
        </Link>
        {t.ownerEmail && (
          <p className="text-xs text-slate-500">
            <a href={`mailto:${t.ownerEmail}`} className="hover:text-violet-700">
              {t.ownerEmail}
            </a>
          </p>
        )}
      </td>
      <td className="min-w-[14rem] px-4 py-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.pill}`}
          >
            <span aria-hidden>{s.icon}</span>
            {s.label}
          </span>
          {t.extensions > 0 && <span className="text-xs text-slate-500">extended {t.extensions}×</span>}
        </div>
        {/* A meter: the fill says how far through, in the state's colour; the track is a lighter step. */}
        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={t.daysTotal}
          aria-valuenow={Math.min(t.daysUsed, t.daysTotal)}
          aria-label={`${Math.min(t.daysUsed, t.daysTotal)} of ${t.daysTotal} trial days used`}
        >
          <div className={`h-full rounded-full ${s.bar}`} style={{ width: `${used}%` }} />
        </div>
        <p className="mt-1 text-xs text-slate-500">{when}</p>
      </td>
      <td className="px-4 py-3">
        <ul className="space-y-0.5 text-xs">
          <Step done={t.setup.numbersLive > 0} label="Phone number live" />
          <Step done={t.setup.menuItems > 0} label={t.setup.menuItems > 0 ? `Menu (${t.setup.menuItems} items)` : 'Menu built'} />
          <Step done={!!t.setup.firstCallAt} label="First call" />
          <Step done={!!t.setup.firstOrderAt} label="First order" />
        </ul>
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-slate-700">
        <p>
          <span className="font-semibold text-slate-900">{t.usage.callsDuringTrial.toLocaleString()}</span> calls
        </p>
        <p>
          <span className="font-semibold text-slate-900">{t.usage.ordersDuringTrial.toLocaleString()}</span> orders
        </p>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {t.state === 'expired' ? (
          <span className={t.usage.callsSinceEnded > 0 ? 'font-semibold text-red-700' : 'text-slate-500'}>
            {t.usage.callsSinceEnded.toLocaleString()} {t.usage.callsSinceEnded === 1 ? 'call' : 'calls'}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      {isAdmin && (
        <td className="px-4 py-3 text-right">
          <button
            type="button"
            onClick={onExtend}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-300 hover:bg-slate-50"
          >
            Extend
          </button>
        </td>
      )}
    </tr>
  );
}

function Step({ done, label }: { done: boolean; label: string }) {
  return (
    <li className={done ? 'text-slate-800' : 'text-slate-400'}>
      <span aria-hidden className={done ? 'text-emerald-600' : ''}>
        {done ? '✓' : '○'}
      </span>{' '}
      {label}
      <span className="sr-only">{done ? ' — done' : ' — not yet'}</span>
    </li>
  );
}
