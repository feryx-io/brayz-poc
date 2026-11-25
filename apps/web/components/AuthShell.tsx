import Link from 'next/link';

/**
 * Shared frame for /login and /register.
 *
 * The landing page sends every call-to-action here, so these pages carry the
 * same dark brand panel rather than dropping the visitor onto a bare form.
 * The panel is decorative and hidden on small screens; the form is the page.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen bg-white">
      {/* Brand panel — decorative, so it is skipped on phones. */}
      <aside className="relative hidden w-[44%] overflow-hidden bg-slate-950 text-white lg:block">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(139,92,246,0.4),transparent_55%),radial-gradient(ellipse_at_bottom,rgba(217,70,239,0.25),transparent_55%)]"
        />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="inline-block h-6 w-6 rounded-md bg-gradient-to-br from-violet-400 to-fuchsia-500" aria-hidden />
            Brayz
          </Link>
          <div>
            <p className="text-3xl font-semibold leading-tight tracking-tight">
              Every call answered.
              <br />
              <span className="bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
                Every guest a regular.
              </span>
            </p>
            <p className="mt-5 max-w-sm leading-relaxed text-slate-400">
              Brayz picks up the phone in a natural voice, takes pickup and delivery orders from your menu, and remembers who is
              calling.
            </p>
          </div>
          <p className="text-sm text-slate-500">© {new Date().getFullYear()} Brayz</p>
        </div>
      </aside>

      <main className="flex flex-1 flex-col justify-center px-6 py-12 sm:px-12">
        <div className="mx-auto w-full max-w-sm">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 lg:hidden">
            <span className="inline-block h-6 w-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-500" aria-hidden />
            Brayz
          </Link>
          <h1 className="mt-8 text-2xl font-semibold tracking-tight text-slate-900 lg:mt-0">{title}</h1>
          {subtitle && <p className="mt-2 text-slate-600">{subtitle}</p>}
          <div className="mt-8">{children}</div>
          <div className="mt-8 text-sm text-slate-600">{footer}</div>
        </div>
      </main>
    </div>
  );
}

/** Text input with the label above it — the shape both auth forms use. */
export function Field({
  label,
  hint,
  ...props
}: { label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-900">{label}</span>
      <input
        {...props}
        className="mt-1.5 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
      />
      {hint && <span className="mt-1.5 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full rounded-xl bg-violet-600 px-4 py-2.5 font-semibold text-white shadow-sm transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {children}
    </button>
  );
}

export function GoogleButton({ busy, onClick, label }: { busy: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <GoogleMark />
      {label}
    </button>
  );
}

export function OrDivider() {
  return (
    <div className="my-5 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400">
      <span className="h-px flex-1 bg-slate-200" />
      or
      <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
      {children}
    </p>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
