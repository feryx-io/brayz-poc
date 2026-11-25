'use client';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useAdminAudit, useAdminStaff, type PlatformAuditEntry } from '@/lib/queries';

/**
 * Who on the Brayz side can open this portal, and what they have done with it.
 *
 * Granting access is the one thing here that cannot be done anywhere else: the
 * bootstrap env var exists only to create the first admin, so without this
 * screen a second one would mean editing the database by hand.
 */
export default function AdminStaffPage() {
  const { api, email: myEmail, platformRole } = useAuth();
  const qc = useQueryClient();
  const staff = useAdminStaff();
  const isAdmin = platformRole === 'admin';
  const [showAudit, setShowAudit] = useState(false);
  const audit = useAdminAudit(showAudit);

  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'support' | 'admin'>('support');

  const setPlatformRole = useMutation({
    mutationFn: (body: { email: string; role: 'support' | 'admin' | null }) =>
      api('/v1/admin/staff', { method: 'POST', body }),
    onSuccess: () => {
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });

  const rows = staff.data?.staff ?? [];

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Brayz staff</h1>
        <p className="mt-1 text-sm text-slate-600">
          <span className="font-medium">support</span> reads this portal.{' '}
          <span className="font-medium">admin</span> also answers support requests and grants access.
        </p>
      </header>

      {isAdmin && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="font-semibold text-slate-900">Grant access</h2>
          <p className="mt-1 text-sm text-slate-600">
            They must have signed in to Brayz at least once — we grant a role to an account, we do not
            create one.
          </p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Email</span>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                type="email"
                placeholder="someone@brayz.ai"
                className="mt-1.5 w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-violet-500"
              />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-700">Role</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as 'support' | 'admin')}
                className="mt-1.5 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="support">support</option>
                <option value="admin">admin</option>
              </select>
            </label>
            <button
              type="button"
              disabled={!email.trim() || setPlatformRole.isPending}
              onClick={() => setPlatformRole.mutate({ email: email.trim(), role })}
              className="rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              Grant
            </button>
          </div>
          {setPlatformRole.isError && (
            <p className="mt-2 text-sm text-red-600">
              {(setPlatformRole.error as Error)?.message ?? 'That did not work.'}
            </p>
          )}
        </section>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          With access ({rows.length})
        </h2>
        <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2 font-medium">Person</th>
                <th className="px-4 py-2 font-medium">Role</th>
                {isAdmin && <th className="px-4 py-2 text-right font-medium">Access</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {staff.isLoading && (
                <tr>
                  <td colSpan={3} className="px-4 py-4 text-slate-500">
                    Loading…
                  </td>
                </tr>
              )}
              {rows.map((s) => {
                const isMe = s.email.toLowerCase() === (myEmail ?? '').toLowerCase();
                return (
                  <tr key={s.id}>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {s.displayName ?? s.email}
                        {isMe && <span className="ml-2 text-xs font-normal text-slate-500">you</span>}
                      </p>
                      {s.displayName && <p className="text-xs text-slate-500">{s.email}</p>}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={
                          'rounded-full px-2.5 py-1 text-xs font-medium ' +
                          (s.platformRole === 'admin'
                            ? 'bg-violet-100 text-violet-800'
                            : 'bg-slate-100 text-slate-700')
                        }
                      >
                        {s.platformRole}
                      </span>
                    </td>
                    {isAdmin && (
                      <td className="px-4 py-3 text-right">
                        {/* An admin cannot demote themselves — the API refuses it,
                            because the last one doing so would lock everyone out. */}
                        {isMe ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : (
                          <div className="flex justify-end gap-3 text-xs">
                            {s.platformRole !== 'admin' && (
                              <button
                                type="button"
                                disabled={setPlatformRole.isPending}
                                onClick={() => setPlatformRole.mutate({ email: s.email, role: 'admin' })}
                                className="text-violet-700 hover:text-violet-600 disabled:opacity-50"
                              >
                                Make admin
                              </button>
                            )}
                            {s.platformRole !== 'support' && (
                              <button
                                type="button"
                                disabled={setPlatformRole.isPending}
                                onClick={() => setPlatformRole.mutate({ email: s.email, role: 'support' })}
                                className="text-slate-600 hover:text-slate-900 disabled:opacity-50"
                              >
                                Make support
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={setPlatformRole.isPending}
                              onClick={() => setPlatformRole.mutate({ email: s.email, role: null })}
                              className="text-red-600 hover:text-red-500 disabled:opacity-50"
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {isAdmin && (
        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">Staff activity</h2>
            <button
              type="button"
              onClick={() => setShowAudit((v) => !v)}
              className="text-sm font-medium text-violet-700 hover:text-violet-600"
            >
              {showAudit ? 'Hide' : 'Show'}
            </button>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            Every look at an identifiable customer is recorded here, with who did it.
          </p>
          {showAudit && (
            <div className="mt-3 overflow-hidden rounded-xl border border-slate-200 bg-white">
              {audit.isLoading && <p className="px-4 py-4 text-sm text-slate-500">Loading…</p>}
              {audit.data?.entries.length === 0 && (
                <p className="px-4 py-4 text-sm text-slate-500">Nothing recorded yet.</p>
              )}
              <ul className="divide-y divide-slate-100">
                {(audit.data?.entries ?? []).map((e) => (
                  <AuditRow key={e.id} entry={e} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function AuditRow({ entry }: { entry: PlatformAuditEntry }) {
  const detail = Object.entries(entry.metadata ?? {})
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(' · ');
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
      <span className="text-slate-900">
        <span className="font-medium">{entry.actorEmail ?? 'unknown'}</span>{' '}
        <span className="text-slate-600">{entry.action}</span>
        {entry.targetType && <span className="text-slate-500"> {entry.targetType}</span>}
      </span>
      <span className="text-xs text-slate-500">
        {detail && <span className="mr-3">{detail}</span>}
        {new Date(entry.createdAt).toLocaleString()}
      </span>
    </li>
  );
}
