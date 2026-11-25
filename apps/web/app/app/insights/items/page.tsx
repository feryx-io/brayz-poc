'use client';

import { Fragment, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  formatMoney,
  menuExportPath,
  useInsightsItems,
  useLocations,
  type MenuItemInsight,
} from '@/lib/queries';
import { StatCard, statLabelClass } from '@/components/StatCard';
import { HISTOGRAM_RANGES, histogramWindow, type HistogramRange } from '@/lib/histogram';
import { useAuth } from '@/lib/auth';

type Filter = 'all' | 'unsold' | 'never' | 'hidden';
type Sort = 'sold' | 'least' | 'revenue' | 'name';

const FILTERS: Array<[Filter, string]> = [
  ['all', 'All items'],
  ['unsold', 'Nothing sold in range'],
  ['never', 'Never ordered'],
  ['hidden', 'Hidden from the AI'],
];

const SORTS: Array<[Sort, string]> = [
  ['sold', 'Most sold'],
  ['least', 'Least sold'],
  ['revenue', 'Revenue'],
  ['name', 'Name'],
];

/**
 * Every item on the menu and what it did — including the items that did
 * nothing.
 *
 * The overview's favourites answer "what sells". This answers the question a
 * restaurant acts on: what earns its place on the menu. An item nobody ordered
 * has no orders to be counted from, so this is built from the menu itself and
 * sales are joined onto it.
 */
export default function InsightsItemsPage() {
  const { activeLocationId, apiBlob } = useAuth();
  const locations = useLocations();
  const location = locations.data?.find((l) => l.id === activeLocationId) ?? locations.data?.[0];
  const tz = location?.timezone ?? 'UTC';

  const [range, setRange] = useState<HistogramRange>('30d');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('sold');
  const [now, setNow] = useState(() => new Date());
  // Which items have their option breakdown open. A menu runs to a hundred
  // items and most have four groups apiece; opening them all at once would
  // bury the table the reader came for.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // Whole local days, the same window maths the overview uses.
  const span = useMemo(() => histogramWindow(range, 'day', now, tz), [range, now, tz]);
  const items = useInsightsItems(location?.id, { from: span.from, to: span.to, tz });
  const d = items.data;

  const shown = useMemo(() => {
    if (!d) return [];
    const kept = d.items.filter((i) =>
      filter === 'unsold' ? i.quantity === 0
      : filter === 'never' ? i.lastOrderedAt === null
      : filter === 'hidden' ? !i.available
      : true,
    );
    const byName = (a: MenuItemInsight, b: MenuItemInsight) => a.name.localeCompare(b.name);
    return [...kept].sort((a, b) =>
      sort === 'name' ? byName(a, b)
      : sort === 'revenue' ? b.revenueCents - a.revenueCents || byName(a, b)
      : sort === 'least' ? a.quantity - b.quantity || byName(a, b)
      : b.quantity - a.quantity || byName(a, b),
    );
  }, [d, filter, sort]);

  const exporting = useMutation({
    mutationFn: async (what: 'items' | 'item-options') => {
      const { blob, filename } = await apiBlob(menuExportPath(location!.id, what, span, tz));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename ?? `menu-${what}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  if (locations.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!location) return <p className="text-slate-500">No location found.</p>;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Menu items</h1>
          <p className="mt-1 text-sm text-slate-500">
            What every item sold — and what sold nothing — over the{' '}
            {HISTOGRAM_RANGES[range].label.toLowerCase().replace('last ', 'last ')}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={() => exporting.mutate('items')}
            disabled={exporting.isPending}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Export items
          </button>
          <button
            type="button"
            onClick={() => exporting.mutate('item-options')}
            disabled={exporting.isPending}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Export options
          </button>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <span className="sr-only">Range</span>
          <select
            value={range}
            onChange={(e) => {
              setRange(e.target.value as HistogramRange);
              setNow(new Date());
            }}
            className="rounded-lg border border-slate-300 bg-white px-3 py-1.5"
          >
            {(Object.keys(HISTOGRAM_RANGES) as HistogramRange[]).map((r) => (
              <option key={r} value={r}>
                {HISTOGRAM_RANGES[r].label}
              </option>
            ))}
          </select>
        </label>
        </div>
      </header>

      {items.isLoading && !d && <p className="text-slate-500">Loading…</p>}
      {items.isError && (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
          {(items.error as Error).message}
        </p>
      )}

      {d && (
        <>
          <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Items on the menu" value={d.totals.onMenu.toLocaleString()} />
            <StatCard
              label="Sold nothing in this range"
              value={d.totals.unsoldInWindow.toLocaleString()}
              hint={`${d.totals.neverOrdered} have never been ordered at all`}
            />
            <StatCard label="Units sold" value={d.totals.quantity.toLocaleString()} />
            <StatCard label="Revenue from these items" value={formatMoney(d.totals.revenueCents)} />
          </section>

          <div className="flex flex-wrap items-center gap-3 text-sm">
            <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label="Filter">
              {FILTERS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={
                    'rounded-md px-2.5 py-1 ' +
                    (filter === value ? 'bg-brayz text-white' : 'text-slate-600 hover:bg-slate-100')
                  }
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-slate-600">
              <span className="sr-only">Sort by</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5"
              >
                {SORTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-slate-400">
              {shown.length} of {d.items.length} shown
            </span>
          </div>

          <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-slate-100 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Section</th>
                  <th className="px-4 py-2 text-right font-medium">Price</th>
                  <th className="px-4 py-2 text-right font-medium">Sold</th>
                  <th className="px-4 py-2 text-right font-medium">Revenue</th>
                  <th className="px-4 py-2 font-medium">Last ordered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                      Nothing matches that filter.
                    </td>
                  </tr>
                )}
                {shown.map((item) => {
                  const options = item.optionGroups ?? [];
                  const open = !!opened[item.menuItemId];
                  return (
                  <Fragment key={item.menuItemId}>
                  <tr
                    className={
                      (item.quantity === 0 ? 'bg-slate-50/60 ' : '') +
                      (options.length ? 'cursor-pointer hover:bg-slate-50' : '')
                    }
                    onClick={
                      options.length
                        ? () => setOpened((o) => ({ ...o, [item.menuItemId]: !o[item.menuItemId] }))
                        : undefined
                    }
                  >
                    <td className="px-4 py-2">
                      {/* What was chosen on it is a click away: "34 large
                          pizzas" is a number, and which toppings went on them
                          is the thing stock gets ordered against. */}
                      {options.length > 0 && (
                        <span className="mr-1.5 inline-block w-3 text-xs text-slate-400">
                          {open ? '▾' : '▸'}
                        </span>
                      )}
                      <span className="text-slate-800">{item.name}</span>
                      {!item.available && (
                        // An item the AI never offers cannot sell; that is a
                        // different problem from one nobody wants.
                        <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                          hidden
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-slate-500">{item.category}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">
                      {formatMoney(item.priceCents)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-800">
                      {item.quantity.toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-600">
                      {formatMoney(item.revenueCents)}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {item.lastOrderedAt ? (
                        new Date(item.lastOrderedAt).toLocaleDateString()
                      ) : (
                        <span className="text-slate-400">never</span>
                      )}
                    </td>
                  </tr>
                  {open && options.length > 0 && (
                    <tr className="bg-slate-50/60">
                      <td colSpan={6} className="px-4 pb-3 pt-1">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                          {options.map((group) => (
                            <div key={group.name}>
                              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                {group.name}
                              </p>
                              <ul className="space-y-0.5">
                                {group.options.map((o) => (
                                  <li key={o.name} className="flex justify-between gap-3 text-sm">
                                    <span className="truncate text-slate-700">{o.name}</span>
                                    <span className="whitespace-nowrap tabular-nums text-slate-500">
                                      {o.quantity.toLocaleString()}
                                      {/* Out of how many of the item — 20 of 34
                                          pizzas is what a stock order is made of. */}
                                      {item.quantity > 0 && (
                                        <span className="ml-1 text-slate-400">
                                          ({Math.round((o.quantity / item.quantity) * 100)}%)
                                        </span>
                                      )}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </section>

          {d.offMenu.length > 0 && (
            <section className="rounded-xl border border-slate-200 bg-white p-5">
              <h2 className={statLabelClass}>Sold, but not on the menu now</h2>
              <p className="mb-3 text-xs text-slate-500">
                Items taken off the menu since, or lines the menu could not price. The money was
                taken either way.
              </p>
              <ul className="divide-y divide-slate-100 text-sm">
                {d.offMenu.map((o) => (
                  <li key={o.name} className="flex items-center justify-between gap-4 py-2">
                    <span className="truncate text-slate-700">{o.name}</span>
                    <span className="whitespace-nowrap text-slate-500">
                      {o.quantity.toLocaleString()} sold · {formatMoney(o.revenueCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="text-xs text-slate-400">
            Open an item to see what was chosen on it — every topping, every sauce, and how often
            each came with it. Revenue is what was charged at the time, not today&apos;s price, so a
            price change since does not rewrite last month&apos;s takings. Canceled orders are never
            counted.
          </p>
        </>
      )}
    </div>
  );
}
