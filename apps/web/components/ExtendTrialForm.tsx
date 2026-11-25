'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';

const PRESETS = [7, 14, 30];

/**
 * Extend a customer's free trial — or start one for an account that never had
 * one. Brayz admins only (the API refuses anyone else), and always with a
 * reason, which goes into the staff audit trail with the change. Days count
 * from the later of today and the current end, so a lapsed trial restarts now.
 */
export function ExtendTrialForm({
  tenantId,
  hasTrial,
  onDone,
}: {
  tenantId: string;
  hasTrial: boolean;
  onDone?: () => void;
}) {
  const { api } = useAuth();
  const qc = useQueryClient();
  const [days, setDays] = useState(7);
  const [reason, setReason] = useState('');
  const extend = useMutation({
    mutationFn: (body: { days: number; reason: string }) =>
      api(`/v1/admin/trials/${tenantId}/extend`, { method: 'POST', body }),
    onSuccess: () => {
      // The trials list and this customer's page both show it.
      void qc.invalidateQueries({ queryKey: ['admin'] });
      setReason('');
      onDone?.();
    },
  });
  const ready = reason.trim().length >= 3 && !extend.isPending;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) extend.mutate({ days, reason: reason.trim() });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Days to add">
        {PRESETS.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
            className={
              'rounded-md px-2.5 py-1 text-xs font-medium transition ' +
              (days === d ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100')
            }
          >
            +{d} days
          </button>
        ))}
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why? (kept in the staff audit trail)"
        maxLength={500}
        aria-label="Reason"
        className="min-w-[16rem] flex-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm"
      />
      <button
        type="submit"
        disabled={!ready}
        className="rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-violet-600 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {extend.isPending ? 'Saving…' : hasTrial ? `Extend by ${days} days` : `Start a ${days}-day trial`}
      </button>
      {extend.isError && (
        <p className="w-full text-xs text-red-600">{(extend.error as Error).message.replace(/^API \d+ [^:]+: /, '')}</p>
      )}
    </form>
  );
}
