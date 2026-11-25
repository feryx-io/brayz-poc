'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['Overview', '/app/insights'],
  ['Menu items', '/app/insights/items'],
];

/**
 * Insights has two views of the same window: what happened (Overview) and what
 * each item on the menu did (Menu items). Tabs rather than two sidebar
 * entries — it is one question asked at two depths, and the sidebar is already
 * long.
 */
export default function InsightsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div>
      <nav className="mb-6 flex gap-1 border-b border-slate-200" aria-label="Insights views">
        {TABS.map(([label, href]) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={
                '-mb-px border-b-2 px-3 py-2 text-sm font-medium ' +
                (active
                  ? 'border-brayz text-brayz-dark'
                  : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900')
              }
            >
              {label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
