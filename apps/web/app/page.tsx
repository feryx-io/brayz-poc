import Link from 'next/link';
import { LANDING_PLANS, LANDING_TRIAL, formatIncludedCalls, formatMonthly } from '@/lib/pricing';

/**
 * Marketing landing page.
 *
 * Every claim here is something the product does today; the sample call is
 * marked illustrative. Pricing comes from `lib/pricing.ts`, which a test holds
 * to `PLANS` in `@brayz/billing` — the prices Stripe actually charges — and the
 * free trial from `LANDING_TRIAL` there, held the same way to what sign-up
 * actually grants (`TRIAL_DAYS` / `TRIAL_PLAN`).
 */

const TRIAL = `${LANDING_TRIAL.days}-day free trial`;

const TRIAL_POINTS = [
  `${LANDING_TRIAL.days} days of ${LANDING_TRIAL.planName}, free`,
  'No credit card',
  'Live on your line in an afternoon',
];

const STEPS: Array<[string, string]> = [
  ['Pick your number', 'Choose a local number in the dashboard, or forward your existing line to it.'],
  ['Brayz answers', 'Every call, in a natural voice: hours, menu questions, pickup and delivery orders, messages, transfers.'],
  ['You see everything', 'Transcripts, recordings, orders and guest history land in your dashboard as they happen.'],
];

const FEATURES: Array<{ title: string; body: string; icon: JSX.Element }> = [
  {
    title: 'Never miss another call',
    body: 'Answered instantly, 24/7, including the dinner rush and the hour after you close.',
    icon: <PhoneIcon />,
  },
  {
    title: 'Pickup and delivery, taken right',
    body: 'Items and options priced from your menu, delivery addresses checked against your area and remembered for next time, all read back and confirmed, then sent to the kitchen or your POS.',
    icon: <ReceiptIcon />,
  },
  {
    title: 'Guests remembered',
    body: 'Repeat callers are recognized by phone number and greeted like the regulars they are.',
    icon: <HeartIcon />,
  },
  {
    title: 'Loyalty and offers',
    body: 'Points, VIP and birthday rewards, and promotions aimed at the guests you choose.',
    icon: <StarIcon />,
  },
  {
    title: 'Your staff’s voices',
    body: 'Optional voice personas for your team, with consent recorded and enforced.',
    icon: <MicIcon />,
  },
  {
    title: 'One dashboard',
    body: 'Calls, transcripts, recordings, orders, messages and guests in one place, on any device.',
    icon: <GridIcon />,
  },
];

const SAMPLE_CALL: Array<['guest' | 'brayz', string]> = [
  ['brayz', 'Thanks for calling Jimmy’s Pizza, this is Sam. Welcome back, Maria! What can I get started for you?'],
  ['guest', 'Hey Sam. Can I get a large half pepperoni, half sausage, and an order of wings?'],
  ['brayz', 'Sure. A large pizza, pepperoni on the left half and sausage on the right, and ten wings. Which sauce for the wings?'],
  ['guest', 'Buffalo, and blue cheese.'],
  ['brayz', 'Got it. That’s $31.50, ready for pickup in about 25 minutes. Should I put it under Maria?'],
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white text-slate-900">
      <header className="sticky top-0 z-20 border-b border-white/10 bg-slate-950/80 text-white backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <span className="inline-block h-6 w-6 rounded-md bg-gradient-to-br from-violet-400 to-fuchsia-500" aria-hidden />
            Brayz
          </Link>
          <div className="hidden items-center gap-8 text-sm text-slate-300 sm:flex">
            <a href="#how" className="hover:text-white">How it works</a>
            <a href="#features" className="hover:text-white">Features</a>
            <a href="#pricing" className="hover:text-white">Pricing</a>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-slate-200 hover:bg-white/10 hover:text-white">
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-white px-3.5 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-violet-50"
            >
              Start free trial
            </Link>
          </div>
        </nav>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-slate-950 text-white">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(139,92,246,0.35),transparent_55%),radial-gradient(ellipse_at_bottom_right,rgba(217,70,239,0.25),transparent_50%)]"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]"
        />
        <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-6 pb-24 pt-20 lg:grid-cols-[1.1fr_0.9fr] lg:pb-32 lg:pt-28">
          <div>
            <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-violet-200">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden />
              Voice AI for restaurants · {LANDING_TRIAL.days} days free
            </p>
            <h1 className="mt-6 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl lg:text-6xl">
              Every call answered.
              <br />
              <span className="bg-gradient-to-r from-violet-300 via-fuchsia-300 to-amber-200 bg-clip-text text-transparent">
                Every guest a regular.
              </span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-slate-300">
              Brayz picks up the phone in a natural voice, takes pickup orders from your real menu, remembers who is
              calling, and puts it all in one dashboard. Your team keeps cooking.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href="/register"
                className="rounded-xl bg-violet-500 px-6 py-3 text-base font-semibold text-white shadow-lg shadow-violet-500/30 transition hover:bg-violet-400"
              >
                Start your {TRIAL}
              </Link>
              <Link
                href="/login"
                className="rounded-xl border border-white/15 bg-white/5 px-6 py-3 text-base font-medium text-white transition hover:bg-white/10"
              >
                Sign in
              </Link>
            </div>
            <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-300">
              {TRIAL_POINTS.map((point) => (
                <li key={point} className="flex items-center gap-2">
                  <CheckIcon className="h-4 w-4 flex-none text-emerald-400" />
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <SampleCall />
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading eyebrow="How it works" title="Live on your phone line in an afternoon" />
        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="relative rounded-2xl border border-slate-200 bg-slate-50 p-7">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
                {i + 1}
              </span>
              <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
              <p className="mt-2 text-slate-600">{body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Features */}
      <section id="features" className="border-y border-slate-200 bg-slate-50">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <SectionHeading eyebrow="What Brayz does" title="A receptionist that knows your menu and your guests" />
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-slate-200 bg-white p-7 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-200/60"
              >
                <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-violet-600 ring-1 ring-violet-100">
                  {f.icon}
                </div>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 leading-relaxed text-slate-600">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mx-auto max-w-6xl px-6 py-24">
        <SectionHeading eyebrow="Pricing" title="Simple plans, per location" />

        {/* The trial comes first: every account starts on it, whichever plan it picks later. */}
        <div className="mt-10 flex flex-col gap-5 rounded-2xl border border-violet-200 bg-violet-50 p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wider text-violet-700">Try it free</p>
            <p className="mt-2 text-xl font-semibold tracking-tight text-slate-900">
              Start with {LANDING_TRIAL.days} days of {LANDING_TRIAL.planName}, on us.
            </p>
            <p className="mt-2 max-w-2xl text-slate-700">
              Every {LANDING_TRIAL.planName} feature, on every location you add, from the day you sign up. No credit
              card. Choose a plan whenever you’re ready — the trial days you have left still count. Not for you? Don’t
              pick one, and you’re never charged.
            </p>
          </div>
          <Link
            href="/register"
            className="shrink-0 rounded-xl bg-violet-600 px-6 py-3 text-center font-semibold text-white shadow-lg shadow-violet-600/20 hover:bg-violet-500"
          >
            Start free trial
          </Link>
        </div>

        <div className="mt-8 grid gap-6 lg:grid-cols-3">
          {LANDING_PLANS.map((p) => (
            <div
              key={p.plan}
              className={
                p.featured
                  ? 'relative rounded-2xl bg-slate-950 p-8 text-white shadow-xl shadow-slate-900/20 ring-1 ring-slate-900'
                  : 'rounded-2xl border border-slate-200 bg-white p-8'
              }
            >
              {p.featured && (
                <span className="absolute -top-3 left-8 rounded-full bg-violet-500 px-3 py-1 text-xs font-semibold text-white">
                  Most popular
                </span>
              )}
              <h3 className="text-lg font-semibold tracking-tight">{p.name}</h3>
              <p className={`mt-1 text-sm ${p.featured ? 'text-slate-300' : 'text-slate-600'}`}>{p.summary}</p>
              <p className="mt-6 flex items-baseline gap-1">
                <span className="text-4xl font-semibold tracking-tight">{formatMonthly(p.monthlyCents)}</span>
                <span className={`text-sm ${p.featured ? 'text-slate-400' : 'text-slate-500'}`}>/ month</span>
              </p>
              <p className={`mt-1 text-sm ${p.featured ? 'text-slate-400' : 'text-slate-500'}`}>
                {formatIncludedCalls(p.includedCalls)}
              </p>
              <ul className={`mt-6 space-y-2.5 text-sm ${p.featured ? 'text-slate-200' : 'text-slate-700'}`}>
                {p.items.map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <CheckIcon className={`mt-0.5 h-4 w-4 flex-none ${p.featured ? 'text-violet-300' : 'text-violet-600'}`} />
                    {item}
                  </li>
                ))}
              </ul>
              <Link
                href="/register"
                className={
                  p.featured
                    ? 'mt-8 block rounded-xl bg-violet-500 px-4 py-2.5 text-center font-semibold text-white hover:bg-violet-400'
                    : 'mt-8 block rounded-xl border border-slate-300 px-4 py-2.5 text-center font-semibold text-slate-900 hover:bg-slate-50'
                }
              >
                Start free trial
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-6 text-center text-sm text-slate-500">
          Every account starts on the {TRIAL} of {LANDING_TRIAL.planName}; pick the plan that fits when you’re ready.
          Additional call volume, SMS and voice cloning are usage-based add-ons. Billing is handled by Stripe.
        </p>
      </section>

      {/* Closing CTA */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="relative overflow-hidden rounded-3xl bg-slate-950 px-8 py-16 text-center text-white sm:px-16">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(139,92,246,0.35),transparent_60%)]"
          />
          <div className="relative">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Stop losing calls to voicemail.</h2>
            <p className="mx-auto mt-4 max-w-xl text-slate-300">
              Start your {TRIAL}, add your restaurant and menu, and give Brayz a call yourself before a guest does.
              No credit card needed.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link
                href="/register"
                className="rounded-xl bg-white px-6 py-3 font-semibold text-slate-950 hover:bg-violet-50"
              >
                Start your free trial
              </Link>
              <Link
                href="/login"
                className="rounded-xl border border-white/15 bg-white/5 px-6 py-3 font-medium text-white hover:bg-white/10"
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-slate-500 sm:flex-row">
          <span>© {new Date().getFullYear()} Brayz</span>
          <div className="flex gap-6">
            <a href="#features" className="hover:text-slate-900">Features</a>
            <a href="#pricing" className="hover:text-slate-900">Pricing</a>
            <Link href="/login" className="hover:text-slate-900">Sign in</Link>
            <Link href="/register" className="hover:text-slate-900">Start free trial</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy Policy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms &amp; Conditions</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div className="max-w-2xl">
      <p className="text-sm font-semibold uppercase tracking-wider text-violet-600">{eyebrow}</p>
      <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h2>
    </div>
  );
}

/** A static, illustrative exchange in the shape of a real Brayz call. */
function SampleCall() {
  return (
    <div className="relative">
      <div aria-hidden className="absolute -inset-4 rounded-[2rem] bg-gradient-to-br from-violet-500/30 to-fuchsia-500/10 blur-2xl" />
      <div className="relative rounded-2xl border border-white/10 bg-slate-900/80 p-5 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between border-b border-white/10 pb-4">
          <div className="flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400" />
            </span>
            <span className="text-sm font-medium text-slate-200">Incoming call · Jimmy’s Pizza</span>
          </div>
          <span className="text-xs text-slate-400">Returning guest</span>
        </div>
        <ol className="mt-4 space-y-3">
          {SAMPLE_CALL.map(([who, line], i) => (
            <li key={i} className={`flex ${who === 'guest' ? 'justify-end' : 'justify-start'}`}>
              <p
                className={
                  who === 'guest'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-white px-4 py-2.5 text-sm text-slate-900'
                    : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-violet-500/20 px-4 py-2.5 text-sm text-violet-50 ring-1 ring-violet-400/30'
                }
              >
                {line}
              </p>
            </li>
          ))}
        </ol>
        <div className="mt-5 grid grid-cols-3 gap-2 border-t border-white/10 pt-4 text-center">
          {[
            ['Order', '$31.50'],
            ['Pickup', '25 min'],
            ['Guest', 'Recognized'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg bg-white/5 px-2 py-2">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{k}</p>
              <p className="mt-0.5 text-sm font-semibold text-white">{v}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-right text-[11px] text-slate-500">Illustrative conversation</p>
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden>
      <path d="M4 10.5l4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const iconProps = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'h-5 w-5', 'aria-hidden': true } as const;
function PhoneIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}
function ReceiptIcon() {
  return (
    <svg {...iconProps}>
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  );
}
function HeartIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />
    </svg>
  );
}
function StarIcon() {
  return (
    <svg {...iconProps}>
      <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg {...iconProps}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function GridIcon() {
  return (
    <svg {...iconProps}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="8" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
      <rect x="13" y="13" width="8" height="8" rx="2" />
    </svg>
  );
}
