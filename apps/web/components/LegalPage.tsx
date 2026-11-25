import Link from 'next/link';
import type { ReactNode } from 'react';
import { BRAND_NAME, CONTACT_EMAIL, LEGAL_UPDATED } from '@/lib/legal';

/** The frame every public legal page shares: title, date, body, and the way back. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 text-slate-800">
      <p className="text-sm font-medium text-slate-500">
        <Link href="/" className="hover:text-slate-800">
          {BRAND_NAME}
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">Last updated {LEGAL_UPDATED}</p>
      <div className="mt-8 space-y-6 text-sm leading-relaxed [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-slate-900 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </div>
      <footer className="mt-12 flex flex-wrap gap-6 border-t border-slate-200 pt-6 text-sm text-slate-500">
        <Link href="/privacy" className="hover:text-slate-800">Privacy Policy</Link>
        <Link href="/terms" className="hover:text-slate-800">Terms &amp; Conditions</Link>
        <Link href="/sms-opt-in" className="hover:text-slate-800">Text alerts opt-in</Link>
      </footer>
    </main>
  );
}

/** How to reach us, in the words the pages use. */
export function ContactLine() {
  return CONTACT_EMAIL ? (
    <>
      email <a href={`mailto:${CONTACT_EMAIL}`} className="text-brayz underline">{CONTACT_EMAIL}</a>
    </>
  ) : (
    <>use the Help page in your {BRAND_NAME} dashboard, or reply HELP to any {BRAND_NAME} text</>
  );
}
