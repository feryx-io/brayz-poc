'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useAdminSupportRequests, type AdminSupportRequest } from '@/lib/queries';

const FILTERS: Array<[string, string]> = [
  ['open', 'Open'],
  ['in_progress', 'In progress'],
  ['resolved', 'Resolved'],
  ['all', 'All'],
];

/** The support queue: what customers have asked Brayz for. */
export default function AdminSupportPage() {
  const [filter, setFilter] = useState('open');
  const requests = useAdminSupportRequests(filter);
  const rows = requests.data?.requests ?? [];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Support</h1>
        <p className="mt-1 text-sm text-slate-600">Oldest first — this is a queue, not a feed.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={
              'rounded-lg px-3 py-1.5 text-sm font-medium transition ' +
              (filter === value
                ? 'bg-slate-900 text-white'
                : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50')
            }
          >
            {label}
          </button>
        ))}
      </div>

      {requests.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {requests.isError && <p className="text-sm text-red-600">Could not load the queue.</p>}
      {!requests.isLoading && rows.length === 0 && (
        <p className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">
          Nothing here. {filter === 'open' ? 'Every request has been picked up.' : ''}
        </p>
      )}

      <ul className="space-y-4">
        {rows.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
      </ul>
    </div>
  );
}

function RequestCard({ request: r }: { request: AdminSupportRequest }) {
  const { api, platformRole } = useAuth();
  const qc = useQueryClient();
  const [reply, setReply] = useState(r.staffReply ?? '');
  const canAnswer = platformRole === 'admin';

  const update = useMutation({
    mutationFn: (body: { status?: string; staffReply?: string | null }) =>
      api(`/v1/admin/support-requests/${r.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  const severityTone =
    r.severity === 'urgent'
      ? 'bg-red-100 text-red-800'
      : r.severity === 'high'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-slate-100 text-slate-700';

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-900">{r.subject}</h2>
          <p className="mt-1 text-xs text-slate-500">
            <Link href={`/admin/customers/${r.tenantId}`} className="font-medium text-violet-700 hover:text-violet-600">
              {r.tenantName}
            </Link>
            {r.locationName ? ` · ${r.locationName}` : ''} · {new Date(r.createdAt).toLocaleString()}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${severityTone}`}>{r.severity}</span>
          <StatusPill status={r.status} />
        </div>
      </div>

      <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm text-slate-800">{r.body}</p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        {r.fromEmail && (
          <a href={`mailto:${r.fromEmail}`} className="hover:text-violet-700">
            {r.fromName ? `${r.fromName} · ` : ''}
            {r.fromEmail}
          </a>
        )}
        {r.locationPhone && (
          <a href={`tel:${r.locationPhone}`} className="hover:text-violet-700">
            {r.locationPhone}
          </a>
        )}
      </div>

      {canAnswer ? (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <label className="block">
            <span className="text-sm font-medium text-slate-900">Reply to the customer</span>
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={3}
              placeholder="What you did, or what you need from them."
              className="mt-1.5 w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">They see this on their Support screen.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={update.isPending || reply.trim() === (r.staffReply ?? '')}
              onClick={() => update.mutate({ staffReply: reply.trim() || null })}
              className="rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              Send reply
            </button>
            {r.status !== 'in_progress' && (
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: 'in_progress' })}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Pick up
              </button>
            )}
            {r.status !== 'resolved' ? (
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: 'resolved' })}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Resolve
              </button>
            ) : (
              <button
                type="button"
                disabled={update.isPending}
                onClick={() => update.mutate({ status: 'open' })}
                className="rounded-lg border border-slate-300 px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Reopen
              </button>
            )}
          </div>
          {update.isError && <p className="mt-2 text-sm text-red-600">That did not save.</p>}
        </div>
      ) : (
        <>
          {r.staffReply && (
            <p className="mt-4 whitespace-pre-wrap rounded-xl border border-violet-100 bg-violet-50 p-4 text-sm text-slate-800">
              {r.staffReply}
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Replying and resolving need the admin platform role.
          </p>
        </>
      )}
    </li>
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
