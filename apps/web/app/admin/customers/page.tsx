'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useAdminCustomers } from '@/lib/queries';

/** Every restaurant on Brayz: who they are, how to reach them, how much they use it. */
export default function AdminCustomersPage() {
  const [q, setQ] = useState('');
  const customers = useAdminCustomers(q);
  const rows = customers.data?.customers ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Customers</h1>
          <p className="mt-1 text-sm text-slate-600">
            {customers.isLoading ? 'Loading…' : `${rows.length} restaurant${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, location or email"
          className="w-72 rounded-xl border border-slate-300 px-3.5 py-2 text-sm shadow-sm outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
        />
      </header>

      {customers.isError && <p className="text-sm text-red-600">Could not load customers.</p>}

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5 font-medium">Restaurant</th>
              <th className="px-4 py-2.5 font-medium">Contact</th>
              <th className="px-4 py-2.5 font-medium">Locations</th>
              <th className="px-4 py-2.5 font-medium">Plan</th>
              <th className="px-4 py-2.5 text-right font-medium">Calls (30d)</th>
              <th className="px-4 py-2.5 text-right font-medium">Support</th>
              <th className="px-4 py-2.5 font-medium">Since</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!customers.isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-500">
                  {q ? 'Nobody matches that search.' : 'No customers yet.'}
                </td>
              </tr>
            )}
            {rows.map((c) => (
              <tr key={c.tenantId} className="hover:bg-slate-50">
                <td className="px-4 py-3">
                  <Link
                    href={`/admin/customers/${c.tenantId}`}
                    className="font-medium text-violet-700 hover:text-violet-600"
                  >
                    {c.name}
                  </Link>
                  {(c.city || c.region) && (
                    <p className="text-xs text-slate-500">{[c.city, c.region].filter(Boolean).join(', ')}</p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {c.contactEmail ? (
                    <a href={`mailto:${c.contactEmail}`} className="text-slate-700 hover:text-violet-700">
                      {c.contactEmail}
                    </a>
                  ) : (
                    <span className="text-slate-400">no owner account</span>
                  )}
                  {c.mainPhone && (
                    <p className="text-xs text-slate-500">
                      <a href={`tel:${c.mainPhone}`} className="hover:text-violet-700">
                        {c.mainPhone}
                      </a>
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums text-slate-700">{c.locationCount}</td>
                <td className="px-4 py-3">
                  {c.plans.length === 0 ? (
                    <span className="text-slate-400">none</span>
                  ) : (
                    <span className="capitalize text-slate-700">{c.plans.join(', ')}</span>
                  )}
                  {c.subscribedLocations > 0 && (
                    <p className="text-xs text-slate-500">{c.subscribedLocations} paying</p>
                  )}
                </td>
                <td className="px-4 py-3 text-right tabular-nums text-slate-900">{c.calls30d}</td>
                <td className="px-4 py-3 text-right">
                  {c.openSupport > 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                      {c.openSupport}
                    </span>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-500">{new Date(c.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
