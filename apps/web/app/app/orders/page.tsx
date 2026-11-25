'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  isFinalOrderStatus,
  useDoneOrders,
  useOrders,
  formatMoney,
  orderItemUnitCents,
  SETTABLE_ORDER_STATUSES,
  type Order,
  type OrderPosSync,
  type SettableOrderStatus,
  modifierLabel,
} from '@/lib/queries';
import { useAuth } from '@/lib/auth';

const STATUS_STYLES: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600',
  confirmed: 'bg-blue-100 text-blue-700',
  accepted: 'bg-indigo-100 text-indigo-700',
  ready: 'bg-amber-100 text-amber-700',
  completed: 'bg-green-100 text-green-700',
  canceled: 'bg-slate-100 text-slate-500',
  failed: 'bg-red-100 text-red-700',
};

/** The one move that usually comes next, so the common path is a single click. */
const NEXT_STATUS: Record<string, SettableOrderStatus | undefined> = {
  confirmed: 'accepted',
  accepted: 'ready',
  ready: 'completed',
};

const NEXT_LABEL: Record<SettableOrderStatus, string> = {
  accepted: 'Accept',
  ready: 'Mark ready',
  completed: 'Complete',
  canceled: 'Cancel',
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString();
}

export default function OrdersPage() {
  const { activeLocationId } = useAuth();
  // The working view is the orders still owed. Completed and canceled ones
  // used to stay in it, and by the end of a day of test calls the tickets that
  // mattered were buried under ones that were done; they live under Done now.
  const orders = useOrders(activeLocationId ?? undefined, 'open');
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const done = useDoneOrders(activeLocationId ?? undefined, { enabled: tab === 'done' });
  // Kitchen mode is a per-device preference — the tablet by the pass wants the
  // board, the office laptop wants the list. Remembered locally, never synced.
  const [kitchen, setKitchen] = useState(false);
  useEffect(() => {
    try {
      setKitchen(localStorage.getItem('brayz.orders.kitchen') === '1');
    } catch {
      // Private windows and blocked site data throw; the list view is fine.
    }
  }, []);
  const setMode = (on: boolean) => {
    setKitchen(on);
    try {
      localStorage.setItem('brayz.orders.kitchen', on ? '1' : '0');
    } catch {
      /* preference just won't persist */
    }
  };

  const open = orders.data ?? [];
  const doneOrders = done.data?.pages.flatMap((p) => p.orders) ?? [];

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Orders</h1>
        <div className="flex rounded-lg border border-slate-300 p-0.5 text-sm">
          {(
            [
              ['List', false],
              ['Kitchen', true],
            ] as const
          ).map(([label, on]) => (
            <button
              key={label}
              onClick={() => setMode(on)}
              className={
                'rounded-md px-3 py-1 ' +
                (kitchen === on ? 'bg-brayz text-white' : 'text-slate-600 hover:bg-slate-50')
              }
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {!kitchen && (
        <div className="mb-4 flex gap-1 border-b border-slate-200 text-sm" role="tablist">
          {(
            [
              ['open', 'Open', orders.data ? open.length : null],
              ['done', 'Done', null],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={
                '-mb-px flex items-center gap-2 border-b-2 px-3 py-2 font-medium ' +
                (tab === key
                  ? 'border-brayz text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-700')
              }
            >
              {label}
              {count !== null && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {(kitchen || tab === 'open') && (
        <>
          {orders.isLoading && <p className="text-slate-500">Loading…</p>}
          {orders.isError && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{(orders.error as Error).message}</p>
          )}
          {orders.data && open.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
              No open orders. Orders taken on a call appear here
              {kitchen ? '.' : '; completed and canceled ones are under Done.'}
            </div>
          )}
          {open.length > 0 && kitchen && <KitchenBoard orders={open} />}
          {open.length > 0 && !kitchen && (
            <div className="space-y-4">
              {open.map((o) => (
                <OrderCard key={o.id} order={o} />
              ))}
            </div>
          )}
        </>
      )}

      {!kitchen && tab === 'done' && (
        <>
          {done.isLoading && <p className="text-slate-500">Loading…</p>}
          {done.isError && (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{(done.error as Error).message}</p>
          )}
          {done.data && doneOrders.length === 0 && (
            <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
              Nothing completed or canceled yet.
            </div>
          )}
          {doneOrders.length > 0 && (
            <div className="space-y-4">
              {doneOrders.map((o) => (
                <OrderCard key={o.id} order={o} />
              ))}
            </div>
          )}
          {done.hasNextPage && (
            <button
              onClick={() => done.fetchNextPage()}
              disabled={done.isFetchingNextPage}
              className="mt-4 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              {done.isFetchingNextPage ? 'Loading…' : 'Show older orders'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Minutes since the order landed — the number a kitchen actually works off. */
function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
}

const KITCHEN_COLUMNS: Array<{ title: string; statuses: string[]; next?: SettableOrderStatus }> = [
  { title: 'New', statuses: ['confirmed'], next: 'accepted' },
  { title: 'Making', statuses: ['accepted'], next: 'ready' },
  { title: 'Ready', statuses: ['ready'], next: 'completed' },
];

/**
 * The pass view: what is on, in what order, and how long it has been waiting.
 * Deliberately spare — read at arm's length on a wall tablet, one tap to move a
 * ticket along, and nothing on it that isn't food or time.
 */
function KitchenBoard({ orders }: { orders: Order[] }) {
  const live = orders.filter((o) => !isFinalOrderStatus(o.status) && o.status !== 'draft');

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {KITCHEN_COLUMNS.map((col) => {
        // Soonest first: the ticket due next is the next one out. For an order
        // taken for a later time that is the time the caller asked for, not the
        // moment it was taken — otherwise a 9am call-ahead for six o'clock sits
        // at the head of the board all day.
        const dueAt = (o: Order) => new Date(o.scheduledFor ?? o.createdAt).getTime();
        const tickets = live.filter((o) => col.statuses.includes(o.status)).sort((a, b) => dueAt(a) - dueAt(b));
        return (
          <div key={col.title}>
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-500">
              {col.title}
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600">
                {tickets.length}
              </span>
            </h2>
            <div className="space-y-3">
              {tickets.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-200 p-6 text-center text-sm text-slate-300">
                  Nothing here
                </div>
              )}
              {tickets.map((o) => (
                <Ticket key={o.id} order={o} next={col.next} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** "12 Main Street, Apt 2, Saratoga Springs 12866" */
function addressLine(a: NonNullable<Order['deliveryAddress']>): string {
  const place = [a.city, a.postalCode].filter(Boolean).join(' ');
  return [a.line1, a.line2, place].filter(Boolean).join(', ');
}

/**
 * Where a delivery goes, on the kitchen ticket and the order card. An address
 * the area check could not place is taken anyway — a failed lookup never
 * loses an order — and says so here, so someone looks before a driver leaves.
 */
function DeliveryInfo({ order: o }: { order: Order }) {
  const a = o.deliveryAddress;
  return (
    <div className="mt-2 rounded-lg bg-sky-50 px-2.5 py-1.5 text-sm text-sky-900">
      <div className="text-xs font-semibold uppercase tracking-wide text-sky-700">Delivery</div>
      {a ? (
        <>
          <div>{addressLine(a)}</div>
          {a.instructions && <div className="text-sky-700">{a.instructions}</div>}
        </>
      ) : (
        <div className="text-sky-700">No address recorded</div>
      )}
      {o.deliveryAreaCheck === 'unverified' && (
        <div className="mt-1 text-xs font-medium text-amber-700">
          Not checked against your delivery area — the address could not be looked up.
        </div>
      )}
    </div>
  );
}

function Ticket({ order: o, next }: { order: Order; next?: SettableOrderStatus }) {
  const { api, canManage } = useAuth();
  const qc = useQueryClient();
  const advance = useMutation({
    mutationFn: (status: SettableOrderStatus) =>
      api(`/v1/orders/${o.id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });

  const waited = minutesSince(o.createdAt);
  // An order for later is not late, however long it has sat: it is due when
  // the caller asked for it. Counting its wait in red from the moment it was
  // taken would have every call-ahead screaming by lunchtime.
  const due = o.scheduledFor ? new Date(o.scheduledFor) : null;
  const late = due ? due.getTime() <= Date.now() : waited >= 15;

  return (
    <div
      className={
        'rounded-xl border bg-white p-4 ' +
        (late ? 'border-red-300 ring-1 ring-red-200' : 'border-slate-200')
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xl font-bold tracking-wider">#{o.code}</span>
        <span
          className={
            'text-sm font-semibold tabular-nums ' + (late ? 'text-red-600' : 'text-slate-500')
          }
        >
          {due ? fmtTime(o.scheduledFor!) : `${waited}m`}
        </span>
      </div>
      {due && (
        <p className="mt-1 rounded bg-amber-100 px-2 py-1 text-sm font-semibold text-amber-900">
          For {fmtTime(o.scheduledFor!)}
        </p>
      )}
      <p className="mt-0.5 text-sm text-slate-500">{o.customerName ?? 'Guest'}</p>
      {o.fulfillmentType === 'delivery' && <DeliveryInfo order={o} />}

      <ul className="mt-3 space-y-1">
        {o.items.map((it) => (
          <li key={it.id} className="text-base leading-snug">
            <span className="font-semibold tabular-nums">{it.quantity}×</span> {it.name}
            {it.modifiers && it.modifiers.length > 0 && (
              // What the caller chose. Part of the order rather than an
              // exception to it, so it reads plainly under the item.
              <span className="block pl-6 text-sm text-slate-600">
                {it.modifiers.map(modifierLabel).join(', ')}
              </span>
            )}
            {it.specialInstructions && (
              // The line that ruins an order if it's missed, so it is the one
              // thing on the ticket that is coloured.
              <span className="block pl-6 text-sm font-medium text-amber-700">
                {it.specialInstructions}
              </span>
            )}
          </li>
        ))}
      </ul>
      {o.notes && <p className="mt-2 text-sm text-amber-700">{o.notes}</p>}

      {canManage && next && (
        <button
          onClick={() => advance.mutate(next)}
          disabled={advance.isPending}
          className="mt-3 w-full rounded-lg bg-brayz px-3 py-2 text-sm font-semibold text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          {advance.isPending ? 'Saving…' : NEXT_LABEL[next]}
        </button>
      )}
    </div>
  );
}

function OrderCard({ order: o }: { order: Order }) {
  const { api, canManage } = useAuth();
  const qc = useQueryClient();
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const setStatus = useMutation({
    mutationFn: (status: SettableOrderStatus) =>
      api(`/v1/orders/${o.id}`, { method: 'PATCH', body: { status } }),
    onSuccess: () => {
      setConfirmingCancel(false);
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  const final = isFinalOrderStatus(o.status);
  const next = NEXT_STATUS[o.status];

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-sm font-semibold tracking-wider text-slate-700">
            #{o.code}
          </span>
          <span
            className={
              'rounded-full px-2 py-0.5 text-xs font-medium ' +
              (STATUS_STYLES[o.status] ?? 'bg-slate-100 text-slate-600')
            }
          >
            {o.status}
          </span>
          <span className="text-xs uppercase tracking-wide text-slate-400">
            {o.fulfillmentType}
          </span>
          <PosBadge pos={o.pos} />
        </div>
        <div className="text-sm text-slate-500">
          {o.scheduledFor ? (
            <span className="font-medium text-amber-700">for {fmtTime(o.scheduledFor)}</span>
          ) : (
            fmtTime(o.createdAt)
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="mb-2 text-sm text-slate-600">
          {o.customerName ?? 'Guest'}
          {o.customerPhone ? ` · ${o.customerPhone}` : ''}
        </div>
        {o.fulfillmentType === 'delivery' && <div className="mb-2"><DeliveryInfo order={o} /></div>}
        <ul className="divide-y divide-slate-100 text-sm">
          {o.items.map((it) => (
            <li key={it.id} className="flex justify-between py-1.5">
              <span className="text-slate-700">
                <span className="tabular-nums text-slate-500">{it.quantity}×</span> {it.name}
                {it.modifiers && it.modifiers.length > 0 && (
                  <span className="text-slate-500">
                    {' '}
                    with {it.modifiers.map(modifierLabel).join(', ')}
                  </span>
                )}
                {it.specialInstructions && (
                  <span className="text-slate-400"> — {it.specialInstructions}</span>
                )}
              </span>
              <span className="tabular-nums text-slate-600">
                {formatMoney(orderItemUnitCents(it) * it.quantity)}
              </span>
            </li>
          ))}
        </ul>
        {o.notes && <p className="mt-2 text-sm text-slate-500">Note: {o.notes}</p>}
        {(o.deliveryFeeCents ?? 0) > 0 && (
          <div className="mt-2 flex justify-between text-sm text-slate-600">
            <span>Delivery fee</span>
            <span className="tabular-nums">{formatMoney(o.deliveryFeeCents ?? 0)}</span>
          </div>
        )}
        <div className="mt-3 flex justify-end border-t border-slate-100 pt-2 text-sm font-semibold">
          Total&nbsp;<span className="tabular-nums">{formatMoney(o.totalCents)}</span>
        </div>

        <PosTrouble order={o} />

        {setStatus.isError && (
          <p className="mt-3 text-sm text-red-600">
            {(setStatus.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
          </p>
        )}

        {canManage && !final && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
            {next && (
              <button
                onClick={() => setStatus.mutate(next)}
                disabled={setStatus.isPending}
                className="rounded-lg bg-brayz px-3 py-1.5 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
              >
                {setStatus.isPending ? 'Saving…' : NEXT_LABEL[next]}
              </button>
            )}
            {/* Every other move stays reachable, just not as the primary button. */}
            {SETTABLE_ORDER_STATUSES.filter((s) => s !== next && s !== 'canceled').map((s) => (
              <button
                key={s}
                onClick={() => setStatus.mutate(s)}
                disabled={setStatus.isPending}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                {NEXT_LABEL[s]}
              </button>
            ))}
            {confirmingCancel ? (
              <span className="flex items-center gap-2 text-sm">
                <span className="text-slate-600">Cancel this order?</span>
                <button
                  onClick={() => setStatus.mutate('canceled')}
                  disabled={setStatus.isPending}
                  className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
                >
                  Yes, cancel
                </button>
                <button
                  onClick={() => setConfirmingCancel(false)}
                  className="text-slate-500 hover:text-slate-700"
                >
                  Keep it
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmingCancel(true)}
                className="ml-auto text-sm text-red-600 hover:text-red-700"
              >
                Cancel order
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** One glance at whether the ticket reached the restaurant's POS. */
function PosBadge({ pos }: { pos?: OrderPosSync | null }) {
  if (!pos) return null;
  const styles: Record<OrderPosSync['status'], string> = {
    synced: 'bg-green-100 text-green-700',
    pending: 'bg-slate-100 text-slate-600',
    failed: 'bg-red-100 text-red-700',
    unsupported: 'bg-slate-100 text-slate-500',
  };
  const labels: Record<OrderPosSync['status'], string> = {
    synced: 'sent to POS',
    pending: 'sending to POS…',
    failed: 'not sent to POS',
    unsupported: 'POS cannot take orders',
  };
  return (
    <span className={'rounded-full px-2 py-0.5 text-xs font-medium ' + styles[pos.status]}>
      {labels[pos.status]}
    </span>
  );
}

/**
 * A ticket that never landed. The order itself is fine — Brayz holds it either
 * way — so this explains what is missing and offers the re-send rather than
 * making the failure look like a lost order.
 */
function PosTrouble({ order }: { order: Order }) {
  const { api, canManage } = useAuth();
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api(`/v1/orders/${order.id}/pos/retry`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
  });

  if (order.pos?.status !== 'failed') return null;

  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm">
      <p className="font-medium text-red-800">This order didn’t reach {order.pos.provider}.</p>
      <p className="mt-0.5 text-red-700">
        The order is saved and the guest is expecting it — it just isn’t on the POS yet.
        {order.pos.attempts > 1 ? ` ${order.pos.attempts} attempts so far.` : ''}
      </p>
      {order.pos.lastError && (
        <p className="mt-1 font-mono text-xs text-red-600">{order.pos.lastError}</p>
      )}
      {retry.isError && (
        <p className="mt-1 text-xs text-red-700">
          {(retry.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}
      {canManage && (
        <button
          onClick={() => retry.mutate()}
          disabled={retry.isPending}
          className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
        >
          {retry.isPending ? 'Re-sending…' : 'Re-send to POS'}
        </button>
      )}
    </div>
  );
}
