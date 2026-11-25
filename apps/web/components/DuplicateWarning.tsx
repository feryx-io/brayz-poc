'use client';

import { ApiError } from '@/lib/api';

export interface DuplicateFinding {
  kind: 'phone_claimed' | 'same_address' | 'same_name_nearby' | 'same_name_in_account';
  blocking: boolean;
  message: string;
}

/** The findings on a 409 from the sign-up checks, or null for any other error. */
export function duplicateFindings(err: unknown): DuplicateFinding[] | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  if (err.code !== 'possible_duplicate' && err.code !== 'phone_claimed') return null;
  const findings = err.body?.findings;
  return Array.isArray(findings) ? (findings as DuplicateFinding[]) : null;
}

/**
 * What the sign-up checks noticed, and — unless something blocks — a way to
 * say "yes, this is a different restaurant" and go on. Says nothing about
 * the other account; the API never sends that.
 */
export function DuplicateWarning({
  findings,
  busy,
  onContinue,
}: {
  findings: DuplicateFinding[];
  busy: boolean;
  onContinue: () => void;
}) {
  const blocked = findings.some((f) => f.blocking);
  return (
    <div
      className={`rounded-lg border px-4 py-3 text-sm ${
        blocked ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'
      }`}
    >
      <p className="font-medium">{blocked ? 'This number is already on Brayz' : 'Is this a duplicate?'}</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        {findings.map((f) => (
          <li key={f.kind}>{f.message}</li>
        ))}
      </ul>
      {!blocked && (
        <button
          type="button"
          onClick={onContinue}
          disabled={busy}
          className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Yes, this is a different restaurant — continue'}
        </button>
      )}
    </div>
  );
}
