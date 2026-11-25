'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useAuth } from '@/lib/auth';

const NAV = [
  ['Overview', '/admin'],
  ['Customers', '/admin/customers'],
  ['Trials', '/admin/trials'],
  ['Support', '/admin/support'],
  ['Staff', '/admin/staff'],
];

/**
 * The Brayz staff portal — deliberately not under /app.
 *
 * /app is a restaurant's own dashboard, scoped to the tenant they picked. This
 * is the opposite: every tenant at once, for us. Keeping them apart means a
 * screen can never be half one and half the other, and the dark chrome is a
 * standing reminder of which one you are looking at.
 *
 * The role check here only decides what is drawn. Every /v1/admin route
 * re-checks it server-side, so a customer typing this URL sees nothing.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { ready, email, displayName, platformRole, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (ready && !email) router.replace('/login');
  }, [ready, email, router]);

  if (!ready) return <Centered>Loading…</Centered>;
  if (!email) return <Centered>Loading…</Centered>;
  if (!platformRole) {
    return (
      <Centered>
        <p className="font-medium text-slate-900">This area is for Brayz staff.</p>
        <Link href="/app/dashboard" className="mt-3 inline-block text-sm font-medium text-violet-700 hover:text-violet-600">
          Back to your dashboard
        </Link>
      </Centered>
    );
  }

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="flex w-56 shrink-0 flex-col bg-slate-950 px-4 py-6 text-slate-300">
        <Link href="/admin" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-white">
          <span className="inline-block h-6 w-6 rounded-md bg-gradient-to-br from-violet-400 to-fuchsia-500" aria-hidden />
          Brayz
        </Link>
        <p className="mt-1 text-xs uppercase tracking-wider text-violet-300">Staff portal</p>

        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map(([label, href]) => {
            const active = href === '/admin' ? pathname === '/admin' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={
                  'rounded-lg px-3 py-2 text-sm transition ' +
                  (active ? 'bg-white/10 font-medium text-white' : 'hover:bg-white/5 hover:text-white')
                }
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto space-y-2 text-xs">
          <p className="truncate text-slate-400" title={email}>
            {displayName ?? email}
          </p>
          <p className="text-slate-500">
            Platform role: <span className="text-violet-300">{platformRole}</span>
          </p>
          <Link href="/app/dashboard" className="block text-slate-400 hover:text-white">
            My restaurant dashboard →
          </Link>
          <button type="button" onClick={logout} className="text-slate-400 hover:text-white">
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-x-auto px-8 py-8">{children}</main>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center bg-slate-50 px-6 text-center">{children}</div>;
}
