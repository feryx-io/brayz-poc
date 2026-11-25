'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';

/** The signed-in user's own account: edit display name, view email + memberships. */
export default function AccountPage() {
  const { email, displayName, memberships, updateProfile } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Seed the input from the loaded profile once it arrives.
  useEffect(() => {
    setName(displayName ?? '');
  }, [displayName]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus('idle');
    setError(null);
    try {
      await updateProfile(name.trim());
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold">Account</h1>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-700">Profile</h2>
        <form className="mt-4 space-y-4" onSubmit={onSubmit}>
          <label className="block">
            <span className="text-sm font-medium">Display name</span>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setStatus('idle');
              }}
              className="mt-1 w-full max-w-sm rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Email</span>
            <input
              type="email"
              value={email ?? ''}
              disabled
              className="mt-1 w-full max-w-sm rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-slate-500"
            />
          </label>
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || name.trim().length === 0}
              className="rounded-lg bg-brayz px-5 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            {status === 'saved' && <span className="text-sm text-green-600">Saved</span>}
            {status === 'error' && <span className="text-sm text-red-600">{error}</span>}
          </div>
        </form>
      </section>

      <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="text-sm font-semibold text-slate-700">Your restaurants</h2>
        {memberships.length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">You’re not a member of any restaurant yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {memberships.map((m) => (
              <li key={m.tenantId} className="flex items-center justify-between py-2.5">
                <span className="text-sm font-medium text-slate-800">{m.tenantName}</span>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                  {m.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
