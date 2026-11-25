'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useAdminCustomer } from '@/lib/queries';
import { ExtendTrialForm } from '@/components/ExtendTrialForm';

/** One restaurant: who works there, what they run, what they pay, what they asked. */
export default function AdminCustomerPage() {
  const params = useParams<{ tenantId: string }>();
  const { platformRole } = useAuth();
  const customer = useAdminCustomer(params?.tenantId);
  const d = customer.data;

  return (
    <div className="space-y-8">
      <div>
        <Link href="/admin/customers" className="text-sm text-slate-500 hover:text-violet-700">
          ← Customers
        </Link>
      </div>

      {customer.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {customer.isError && <p className="text-sm text-red-600">Could not load this customer.</p>}

      {d && (
        <>
          <header>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{d.name}</h1>
            <p className="mt-1 text-sm text-slate-600">
              Customer since {new Date(d.createdAt).toLocaleDateString()} · {d.locations.length} location
              {d.locations.length === 1 ? '' : 's'} · {money(d.mrrCents)}/month
            </p>
          </header>

          <section className="grid gap-4 sm:grid-cols-3">
            <Stat label="Calls today" value={d.calls.today} />
            <Stat label="Calls (30 days)" value={d.calls.last30Days} />
            <Stat label="Calls all time" value={d.calls.total} />
          </section>

          <Panel title="Free trial">
            <div className="space-y-4 px-4 py-4">
              {d.trial ? (
                <p className="text-sm text-slate-700">
                  {d.trial.active ? (
                    <>
                      <span className="font-semibold text-slate-900">
                        {d.trial.daysLeft} {d.trial.daysLeft === 1 ? 'day' : 'days'} left
                      </span>{' '}
                      · ends {new Date(d.trial.endsAt).toLocaleDateString()}
                    </>
                  ) : (
                    <>
                      <span className="font-semibold text-red-700">Ended</span>{' '}
                      {new Date(d.trial.endsAt).toLocaleDateString()} — unless a location pays, Brayz is not answering
                      their calls.
                    </>
                  )}
                  {d.trial.startedAt && (
                    <span className="text-slate-500"> · started {new Date(d.trial.startedAt).toLocaleDateString()}</span>
                  )}
                </p>
              ) : (
                <p className="text-sm text-slate-500">
                  No trial — this account is from before trials and keeps unrestricted access.
                </p>
              )}
              {platformRole === 'admin' && <ExtendTrialForm tenantId={d.tenantId} hasTrial={!!d.trial} />}
              {d.trial && d.trial.history.length > 0 && (
                <ul className="divide-y divide-slate-100 border-t border-slate-100 text-sm">
                  {d.trial.history.map((h) => (
                    <li key={h.at} className="py-2">
                      <p className="text-slate-900">
                        {h.action === 'admin.trial.granted' ? 'Started' : 'Extended'} to{' '}
                        {new Date(h.to).toLocaleDateString()}
                        {h.days ? ` (+${h.days} days)` : ''} — <span className="text-slate-700">{h.reason}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {h.actorEmail ?? 'unknown'} · {new Date(h.at).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel title="Locations">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Location</th>
                  <th className="px-4 py-2 font-medium">Phone</th>
                  <th className="px-4 py-2 font-medium">Plan</th>
                  <th className="px-4 py-2 text-right font-medium">Calls (30d)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.locations.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{l.name}</p>
                      {l.address && <p className="text-xs text-slate-500">{l.address}</p>}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{l.mainPhone ?? <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">
                      <span className="capitalize text-slate-700">{l.plan ?? 'none'}</span>
                      <p className="text-xs text-slate-500">
                        {l.subscriptionStatus.replace(/_/g, ' ')}
                        {l.cancelAtPeriodEnd ? ' · cancelling' : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-900">{l.calls30d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="People">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {d.members.map((m) => (
                  <tr key={m.userId}>
                    <td className="px-4 py-3 text-slate-900">{m.displayName ?? <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3">
                      <a href={`mailto:${m.email}`} className="text-violet-700 hover:text-violet-600">
                        {m.email}
                      </a>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-700">{m.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>

          <Panel title="Support history">
            {d.supportRequests.length === 0 ? (
              <p className="px-4 py-4 text-sm text-slate-500">They have never asked for help.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {d.supportRequests.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium text-slate-900">{r.subject}</p>
                      <p className="text-xs text-slate-500">
                        {new Date(r.createdAt).toLocaleString()} · {r.severity}
                      </p>
                    </div>
                    <StatusPill status={r.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
      <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{value}</p>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'open'
      ? 'bg-amber-100 text-amber-800'
      : status === 'in_progress'
        ? 'bg-blue-100 text-blue-800'
        : 'bg-emerald-100 text-emerald-800';
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium capitalize ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function money(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}
