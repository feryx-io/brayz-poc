'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useLocations, useSupportRequests, type SupportRequest } from '@/lib/queries';

const SEVERITIES: Array<[SupportRequest['severity'], string, string]> = [
  ['low', 'Low', 'A question, or something to look at eventually.'],
  ['normal', 'Normal', 'Something is wrong but the phone still works.'],
  ['high', 'High', 'Calls or orders are affected right now.'],
  ['urgent', 'Urgent', 'The phone is not being answered.'],
];

/**
 * Asking Brayz for help, and reading what we said back.
 *
 * The counterpart of the staff queue at /admin/support. A restaurant only ever
 * sees its own requests — the API scopes them to the tenant, not to the person,
 * so an owner can see what their manager reported without a second screen.
 */
export default function HelpPage() {
  const { api, activeTenantId, activeLocationId, canManage } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const requests = useSupportRequests();

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<SupportRequest['severity']>('normal');
  const [locationId, setLocationId] = useState<string>('');
  const [sent, setSent] = useState(false);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['support-requests', activeTenantId] });

  const create = useMutation({
    mutationFn: () =>
      api('/v1/support-requests', {
        method: 'POST',
        body: {
          subject: subject.trim(),
          body: body.trim(),
          severity,
          locationId: locationId || null,
        },
      }),
    onSuccess: () => {
      setSubject('');
      setBody('');
      setSeverity('normal');
      setSent(true);
      void invalidate();
    },
  });

  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/v1/support-requests/${id}`, { method: 'DELETE' }),
    onSuccess: () => void invalidate(),
  });

  const list = requests.data?.requests ?? [];
  const canSend = subject.trim().length >= 3 && body.trim().length > 0 && !create.isPending;

  return (
    <div className="max-w-3xl space-y-8">
      <header>
        <h1 className="text-2xl font-bold">Help</h1>
        <p className="text-sm text-slate-500">
          Tell us what is wrong and we will pick it up. We answer here — check back on this screen.
        </p>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="font-semibold text-slate-900">Ask for help</h2>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-700">What is happening?</span>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setSent(false);
            }}
            maxLength={200}
            placeholder="Callers are hearing a busy signal"
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brayz"
          />
        </label>

        <label className="mt-4 block">
          <span className="text-sm font-medium text-slate-700">Tell us more</span>
          <textarea
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              setSent(false);
            }}
            rows={5}
            maxLength={5000}
            placeholder="When it started, what a caller hears, anything you already tried."
            className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-brayz"
          />
        </label>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-sm font-medium text-slate-700">How urgent is it?</span>
            <select
              value={severity}
              onChange={(e) => setSeverity(e.target.value as SupportRequest['severity'])}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              {SEVERITIES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">
              {SEVERITIES.find(([v]) => v === severity)?.[2]}
            </span>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-700">Which location?</span>
            <select
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Not about one location</option>
              {(locations.data ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            {activeLocationId && !locationId && (
              <button
                type="button"
                onClick={() => setLocationId(activeLocationId)}
                className="mt-1 text-xs text-brayz hover:underline"
              >
                Use the location I am looking at
              </button>
            )}
          </label>
        </div>

        <div className="mt-5 flex items-center gap-3">
          <button
            type="button"
            disabled={!canSend}
            onClick={() => create.mutate()}
            className="rounded-lg bg-brayz px-4 py-2 text-sm font-semibold text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {create.isPending ? 'Sending…' : 'Send to Brayz'}
          </button>
          {sent && <span className="text-sm text-emerald-700">Sent. We will reply on this screen.</span>}
          {create.isError && <span className="text-sm text-red-600">That did not send. Try again.</span>}
        </div>
      </section>

      <section>
        <h2 className="font-semibold text-slate-900">What you have asked us</h2>
        {requests.isLoading && <p className="mt-3 text-sm text-slate-500">Loading…</p>}
        {!requests.isLoading && list.length === 0 && (
          <p className="mt-3 rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-500">
            You have not asked us for anything yet.
          </p>
        )}
        <ul className="mt-3 space-y-4">
          {list.map((r) => (
            <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{r.subject}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {new Date(r.createdAt).toLocaleString()}
                    {r.locationName ? ` · ${r.locationName}` : ''}
                    {r.fromName || r.fromEmail ? ` · ${r.fromName ?? r.fromEmail}` : ''} · {r.severity}
                  </p>
                </div>
                <StatusPill status={r.status} />
              </div>

              <p className="mt-3 whitespace-pre-wrap text-sm text-slate-700">{r.body}</p>

              {r.staffReply ? (
                <div className="mt-4 rounded-xl border border-brayz/20 bg-brayz/5 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-brayz-dark">Brayz</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{r.staffReply}</p>
                  {r.repliedAt && (
                    <p className="mt-2 text-xs text-slate-500">{new Date(r.repliedAt).toLocaleString()}</p>
                  )}
                </div>
              ) : (
                <p className="mt-4 text-xs text-slate-500">
                  {r.status === 'open' ? 'Waiting for us to pick this up.' : 'We are on it.'}
                </p>
              )}

              {/* Only while it is still open: once we have replied, deleting it
                  would take our answer away from whoever else needs to read it. */}
              {canManage && r.status === 'open' && (
                <button
                  type="button"
                  disabled={withdraw.isPending}
                  onClick={() => withdraw.mutate(r.id)}
                  className="mt-4 text-xs text-slate-500 hover:text-red-600 disabled:opacity-50"
                >
                  Never mind — withdraw this
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
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
  const label = status === 'open' ? 'Sent' : status === 'in_progress' ? 'Brayz is on it' : 'Resolved';
  return (
    <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${tone}`}>{label}</span>
  );
}
