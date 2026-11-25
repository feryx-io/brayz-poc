'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useLocations } from '@/lib/queries';
import { SetupWizard } from '@/components/SetupWizard';
import { AddLocationModal } from '@/components/AddLocationModal';
import { TrialBanner } from '@/components/TrialBanner';

const NAV = [
  ['Dashboard', '/app/dashboard'],
  ['Insights', '/app/insights'],
  ['Calls', '/app/calls'],
  ['Messages', '/app/messages'],
  ['Orders', '/app/orders'],
  ['Guests', '/app/guests'],
  ['Menu', '/app/menu'],
  ['Assistant', '/app/assistant'],
  ['Loyalty', '/app/loyalty'],
  ['Staff Voices', '/app/staff'],
  ['Settings', '/app/settings'],
  ['Account', '/app/account'],
  ['Help', '/app/help'],
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { ready, email, displayName, memberships, activeTenantId, activeLocationId, setActiveLocation, setActiveTenant, canManage, platformRole, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const locations = useLocations();
  const [addingLocation, setAddingLocation] = useState(false);

  useEffect(() => {
    if (ready && !email) router.replace('/login');
  }, [ready, email, router]);

  // Default/validate the active location against the current tenant's locations.
  useEffect(() => {
    const locs = locations.data;
    if (!locs || locs.length === 0) return;
    if (!activeLocationId || !locs.some((l) => l.id === activeLocationId)) {
      setActiveLocation(locs[0].id);
    }
  }, [locations.data, activeLocationId, setActiveLocation]);

  if (!ready || (!email && typeof window !== 'undefined')) {
    return <CenteredNote>Loading…</CenteredNote>;
  }
  // Brand-new account: full setup wizard (creates the business too).
  if (memberships.length === 0) {
    return <SetupWizard />;
  }
  // Has a tenant but it has no location yet → resume setup at the location step.
  if (locations.isLoading) {
    return <CenteredNote>Loading…</CenteredNote>;
  }
  if ((locations.data?.length ?? 0) === 0) {
    return <SetupWizard resumeTenantId={activeTenantId} />;
  }

  const activeName =
    memberships.find((m) => m.tenantId === activeTenantId)?.tenantName ?? 'Select restaurant';
  const locs = locations.data ?? [];
  const activeLocationName = locs.find((l) => l.id === activeLocationId)?.name;

  return (
    <div className="flex min-h-screen">
      {addingLocation && <AddLocationModal onClose={() => setAddingLocation(false)} />}
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-200 bg-white px-4 py-6">
        <Link href="/app/dashboard" className="text-lg font-bold text-brayz">
          Brayz
        </Link>

        <select
          value={activeTenantId ?? ''}
          onChange={(e) => setActiveTenant(e.target.value)}
          className="mt-4 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
          aria-label="Active restaurant"
        >
          {memberships.map((m) => (
            <option key={m.tenantId} value={m.tenantId}>
              {m.tenantName} ({m.role})
            </option>
          ))}
        </select>

        <select
          value={activeLocationId ?? ''}
          onChange={(e) => setActiveLocation(e.target.value)}
          className="mt-2 w-full rounded-lg border border-slate-300 px-2 py-1 text-sm"
          aria-label="Active location"
        >
          {locs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        {canManage && (
          <button
            onClick={() => setAddingLocation(true)}
            className="mt-2 w-full rounded-lg border border-dashed border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:border-brayz hover:text-brayz"
          >
            + Add location
          </button>
        )}

        <nav className="mt-6 flex-1 space-y-1">
          {NAV.map(([label, href]) => (
            <Link
              key={href}
              href={href}
              className={
                'block rounded-lg px-3 py-2 text-sm font-medium ' +
                (pathname === href
                  ? 'bg-brayz/10 text-brayz-dark'
                  : 'text-slate-700 hover:bg-slate-100')
              }
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* Brayz staff only. The link is a convenience — /admin re-checks the
            platform role, and every /v1/admin route checks it again. */}
        {platformRole && (
          <Link
            href="/admin"
            className="mt-4 block rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800"
          >
            Brayz staff portal →
          </Link>
        )}

        <div className="mt-4 border-t border-slate-100 pt-4 text-xs text-slate-500">
          {displayName && <p className="truncate font-medium text-slate-700">{displayName}</p>}
          <p className="truncate">{email}</p>
          <button onClick={() => logout()} className="mt-2 text-slate-600 hover:text-brayz">
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 px-8 py-8">
        <p className="mb-4 text-xs uppercase tracking-wide text-slate-400">
          {activeName}
          {activeLocationName && <span className="text-slate-300"> · {activeLocationName}</span>}
        </p>
        <TrialBanner />
        {children}
      </main>
    </div>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center text-slate-500">{children}</div>;
}
