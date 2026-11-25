'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { normalizePhone } from '@/lib/phone';

interface SmsConsent {
  phone: string | null;
  state: 'none' | 'pending' | 'on' | 'off';
  since: string | null;
  disclosure: string;
  disclosureVersion: string;
  smsConfigured: boolean;
  history: Array<{ action: string; source: string; createdAt: string }>;
}

/**
 * Where the restaurant's order and message alerts are texted, and its owner's
 * agreement to them. Carriers require that everyone Brayz texts opted in and
 * can stop, so the box starts unchecked beside the full disclosure, and alerts
 * start only after the number replies YES to the confirmation text.
 */
export function TextAlertsCard({ locationId, canManage }: { locationId: string; canManage: boolean }) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const consent = useQuery({
    queryKey: ['sms-consent', locationId],
    // Polls while waiting, so "On" appears when they reply YES.
    refetchInterval: (q) => (q.state.data?.state === 'pending' ? 5_000 : false),
    queryFn: () => api<SmsConsent>(`/v1/locations/${locationId}/sms-consent`),
  });
  const [phone, setPhone] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (consent.data) setPhone(consent.data.phone ?? '');
  }, [consent.data?.phone]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sms-consent', locationId] });
    qc.invalidateQueries({ queryKey: ['location'] });
    qc.invalidateQueries({ queryKey: ['text-health'] });
  };
  const grant = useMutation({
    mutationFn: () =>
      api(`/v1/locations/${locationId}/sms-consent`, {
        method: 'POST',
        body: { phone: normalizePhone(phone), agreed: true },
      }),
    onSuccess: () => {
      setAgreed(false);
      setEditing(false);
      refresh();
    },
  });
  const resend = useMutation({
    mutationFn: () => api(`/v1/locations/${locationId}/sms-consent/resend`, { method: 'POST' }),
  });
  const revoke = useMutation({
    mutationFn: () => api(`/v1/locations/${locationId}/sms-consent`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const d = consent.data;
  const showForm = canManage && (editing || !d || d.state === 'none' || d.state === 'off');
  const error = (grant.error ?? resend.error ?? revoke.error) as Error | null;
  const when = d?.since ? new Date(d.since).toLocaleString() : null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="mb-1 font-semibold">Text alerts</h2>
      <p className="mb-4 text-sm text-slate-500">
        New orders, order changes and messages callers leave, texted to a phone at the restaurant.
      </p>

      {consent.isLoading && <p className="text-sm text-slate-500">Loading…</p>}

      {d && d.state === 'on' && (
        <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-800">
          <span className="font-semibold">On</span> — texting {d.phone}. Confirmed {when}.
        </p>
      )}
      {d && d.state === 'pending' && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p>
            <span className="font-semibold">Waiting for a reply.</span> We texted {d.phone} — reply <b>YES</b> to
            that text to turn alerts on. Nothing else is sent until then.
          </p>
          {canManage && (
            <button
              onClick={() => resend.mutate()}
              disabled={resend.isPending}
              className="mt-2 text-sm font-medium text-amber-900 underline disabled:opacity-50"
            >
              {resend.isPending ? 'Sending…' : resend.isSuccess ? 'Sent again' : 'Send the text again'}
            </button>
          )}
        </div>
      )}
      {d && d.state === 'off' && (
        <p className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
          <span className="font-semibold">Off</span> — {d.phone} stopped alerts {when}
          {d.history[0]?.source === 'sms_reply' ? ' by replying STOP' : ''}. Orders and messages are still on the
          Orders and Messages screens.
        </p>
      )}
      {d && d.state === 'none' && !showForm && (
        <p className="text-sm text-slate-500">Not set up. Ask a manager to turn text alerts on.</p>
      )}
      {d && !d.smsConfigured && (
        <p className="mt-2 text-xs text-slate-400">Texting isn’t configured on this deployment yet.</p>
      )}

      {showForm && d && (
        <div className="mt-4 space-y-3">
          <label className="block max-w-xs">
            <span className="text-sm font-medium">Mobile number for alerts</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(518) 555-1234"
              inputMode="tel"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              className="mt-1"
            />
            <span>
              {d.disclosure}{' '}
              <Link href="/terms#sms" className="text-brayz underline" target="_blank">
                SMS Terms
              </Link>{' '}
              and{' '}
              <Link href="/privacy" className="text-brayz underline" target="_blank">
                Privacy Policy
              </Link>
            </span>
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => grant.mutate()}
              disabled={!agreed || !normalizePhone(phone) || grant.isPending}
              className="rounded-lg bg-brayz px-3 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              {grant.isPending ? 'Sending…' : 'Turn on text alerts'}
            </button>
            {editing && (
              <button onClick={() => setEditing(false)} className="text-sm text-slate-500 hover:text-slate-700">
                Cancel
              </button>
            )}
          </div>
          <p className="text-xs text-slate-500">We’ll text that number to confirm. Reply YES to start alerts.</p>
        </div>
      )}

      {canManage && d && (d.state === 'on' || d.state === 'pending') && !editing && (
        <div className="mt-3 flex gap-4 text-sm">
          <button onClick={() => setEditing(true)} className="text-slate-600 underline hover:text-slate-800">
            Use a different number
          </button>
          <button
            onClick={() => revoke.mutate()}
            disabled={revoke.isPending}
            className="text-red-600 underline hover:text-red-700 disabled:opacity-50"
          >
            Turn off
          </button>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error.message.replace(/^API \d+ [^:]+: /, '')}</p>}
    </section>
  );
}
