'use client';

import Link from 'next/link';

import { StatCard } from '@/components/StatCard';
import {
  formatMoney,
  useCalls,
  useLocations,
  useLoyaltyStats,
  useMenu,
  useMessages,
  useOrderCount,
  useSmsConsentState,
  useTextHealth,
} from '@/lib/queries';
import { dayKeyInTz, rangeInTz } from '@/lib/time';
import { useAuth } from '@/lib/auth';

export default function DashboardPage() {
  const { activeLocationId } = useAuth();
  const locations = useLocations();
  const activeLocation = locations.data?.find((l) => l.id === activeLocationId) ?? locations.data?.[0];
  const menu = useMenu(activeLocation?.id);
  // Today's calls in the restaurant's own day, not the browser's.
  const tz = activeLocation?.timezone ?? 'UTC';
  const todayKey = dayKeyInTz(new Date(), tz);
  const today = rangeInTz(todayKey, todayKey, tz);
  const calls = useCalls(activeLocation?.id, today);
  const orderCount = useOrderCount(activeLocation?.id, today);
  const texts = useTextHealth(activeLocation?.id);
  const alerts = useSmsConsentState(activeLocation?.id);
  const loyalty = useLoyaltyStats(activeLocation?.id);
  const messages = useMessages(activeLocation?.id, 'new');

  const menuItemCount =
    menu.data?.categories.reduce((sum, c) => sum + c.items.length, 0) ?? 0;

  const callsToday =
    calls.data?.calls.length ?? 0;
  const activeCalls =
    calls.data?.calls.filter((c) => c.status === 'started' || c.status === 'in_progress').length ?? 0;
  const ordersToday = orderCount.data?.count ?? '—';

  // A number on this screen is the start of a question — "six messages
  // waiting" is only useful next to the screen that shows them. Locations has
  // no one destination (the switcher is in the sidebar), so it stays a plain
  // card rather than guessing.
  const cards: Array<{ label: string; value: string | number; href?: string; live?: boolean }> = [
    { label: 'Locations', value: locations.data?.length ?? '—' },
    { label: 'Menu items', value: activeLocation ? menuItemCount : '—', href: '/app/menu' },
    { label: 'Calls today', value: activeLocation ? callsToday : '—', href: '/app/calls' },
    // The one card that is about this second rather than today, and says so.
    { label: 'active calls', value: activeLocation ? activeCalls : '—', href: '/app/calls', live: true },
    { label: 'Orders today', value: activeLocation ? ordersToday : '—', href: '/app/orders' },
    {
      label: 'Messages waiting',
      value: activeLocation ? (messages.data?.newCount ?? '—') : '—',
      href: '/app/messages',
    },
  ];

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">
          {activeLocation ? `${activeLocation.name} — today.` : 'Today, at a glance.'}
        </p>
      </header>

      {alerts.data?.smsConfigured && alerts.data.state !== 'on' && (
        // Alerts are texted only to a number whose owner agreed and replied
        // YES, so until then the restaurant hears about nothing by text.
        <div className="mb-6 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          <span className="font-semibold">
            {alerts.data.state === 'pending'
              ? `Text alerts are waiting for a YES reply from ${alerts.data.phone}.`
              : alerts.data.state === 'off'
                ? 'Text alerts are off.'
                : 'Text alerts aren’t set up.'}
          </span>{' '}
          New orders and messages won’t be texted until they’re on.{' '}
          <Link href="/app/settings" className="text-brayz underline">
            Text alerts settings
          </Link>
        </div>
      )}

      {texts.data?.latest?.notDelivered && (
        // The restaurant finds out about orders and messages by text. When
        // those texts are not arriving nothing else on the screen says so:
        // on 2026-09-14 every text had been undelivered for a week while the
        // app recorded each one as sent.
        <div role="alert" className="mb-6 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">Order and message texts aren’t reaching the restaurant.</p>
          <p className="mt-1">{texts.data.latest.reason}</p>
          <p className="mt-1 text-amber-800">
            {texts.data.notDelivered} of {texts.data.sent} texts in the last {texts.data.windowDays} days weren’t
            delivered. New orders and messages are still on the{' '}
            <Link href="/app/orders" className="underline">
              Orders
            </Link>{' '}
            and{' '}
            <Link href="/app/messages" className="underline">
              Messages
            </Link>{' '}
            screens.
          </p>
        </div>
      )}

      {locations.isLoading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => (
            <StatCard
              key={card.label}
              label={card.label}
              value={card.value}
              href={card.href}
              live={card.live ? (calls.isError ? 'stale' : 'on') : undefined}
            />
          ))}
        </div>
      )}

      {loyalty.data?.enabled && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">
            Loyalty — last 30 days
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(
              [
                ['Members', loyalty.data.members],
                ['VIP guests', loyalty.data.vipCount],
                ['Points outstanding', loyalty.data.pointsOutstanding.toLocaleString()],
                ['Points earned (30d)', loyalty.data.last30Days.pointsEarned.toLocaleString()],
                ['Redemptions (30d)', loyalty.data.last30Days.redemptions],
                ['Discounts given (30d)', formatMoney(loyalty.data.last30Days.discountCents)],
                ['Birthday bonuses (30d)', loyalty.data.last30Days.birthdayBonuses],
                ['Win-backs (30d)', loyalty.data.last30Days.winbackBonuses],
              ] as Array<[string, string | number]>
            ).map(([label, value]) => (
              <StatCard key={label} label={label} value={value} />
            ))}
          </div>
        </section>
      )}

      <p className="mt-6 text-sm text-slate-500">
        This is today. For what Brayz did over a longer stretch — the calls that would have rung
        out, orders captured, upsell revenue, favourite items —{' '}
        <Link href="/app/insights" className="text-brayz hover:underline">
          see Insights
        </Link>
        .
      </p>
    </div>
  );
}
