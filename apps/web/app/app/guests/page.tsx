'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useGuests, useGuest, formatMoney, type DeliveryAddressView } from '@/lib/queries';
import { statLabelClass, statValueClass } from '@/components/StatCard';
import { useAuth } from '@/lib/auth';

function fmtDate(iso?: string | null) {
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

/**
 * `?guest=<id>` opens straight onto that profile — what the Insights screen's
 * top-guest rows link to, so an owner reading "Regular Rita, 4 orders" can see
 * who she is without hunting for the name again. `useSearchParams` needs a
 * Suspense boundary in a statically rendered page, hence the wrapper.
 */
export default function GuestsPage() {
  return (
    <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
      <GuestsScreen />
    </Suspense>
  );
}

function GuestsScreen() {
  const { activeLocationId, canManage } = useAuth();
  const guests = useGuests(activeLocationId ?? undefined);
  const asked = useSearchParams().get('guest');
  const [selectedId, setSelectedId] = useState<string | null>(asked);
  // The link decides who is shown on arrival; clicking the list afterwards
  // still wins, so this never fights the owner for control of the panel.
  useEffect(() => {
    if (asked) setSelectedId(asked);
  }, [asked]);

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">Guests</h1>

      {guests.isLoading && <p className="text-slate-500">Loading…</p>}

      {guests.data && guests.data.length === 0 && (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
          No guests yet. A guest profile is created when a caller places an order or the bot saves a note.
        </div>
      )}

      {guests.data && guests.data.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
          <ul className="space-y-1">
            {guests.data.map((g) => {
              const active = g.id === selectedId;
              return (
                <li key={g.id}>
                  <button
                    onClick={() => setSelectedId(g.id)}
                    className={
                      'w-full rounded-lg border px-3 py-2 text-left ' +
                      (active
                        ? 'border-brayz bg-brayz/5'
                        : 'border-slate-200 bg-white hover:border-slate-300')
                    }
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800">{g.displayName ?? 'Unknown guest'}</span>
                      {!g.memoryEnabled && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                          memory off
                        </span>
                      )}
                    </div>
                    <div className="text-xs tabular-nums text-slate-500">
                      {g.phones[0] ?? 'no number'} · {g.orderCount} order{g.orderCount === 1 ? '' : 's'}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <div>
            {selectedId ? (
              <GuestDetailPanel id={selectedId} canManage={canManage} onDeleted={() => setSelectedId(null)} />
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-400">
                Select a guest to view their profile and order history.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** "12 Main Street, Apt 2, Saratoga Springs 12866" */
function addressLine(a: DeliveryAddressView): string {
  const place = [a.city, a.postalCode].filter(Boolean).join(' ');
  return [a.line1, a.line2, place].filter(Boolean).join(', ');
}

/**
 * The address the guest's last delivery went to — what the bot offers back on
 * their next call ("are we still delivering to 12 Main Street?"). Guest memory
 * like the notes: the restaurant can correct it or remove it (rule #6).
 */
function SavedAddressSection({
  address,
  updatedAt,
  canManage,
  onSave,
}: {
  address: DeliveryAddressView | null | undefined;
  updatedAt?: string | null;
  canManage: boolean;
  onSave: (next: DeliveryAddressView | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DeliveryAddressView>({ line1: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const begin = () => {
    setDraft(address ?? { line1: '' });
    setError(null);
    setEditing(true);
  };
  const submit = async (next: DeliveryAddressView | null) => {
    setBusy(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the address');
    } finally {
      setBusy(false);
    }
  };
  const cleaned = (): DeliveryAddressView | null => {
    const opt = (v?: string) => v?.trim() || undefined;
    const line1 = draft.line1.trim();
    if (line1.length < 3) return null;
    return {
      line1,
      line2: opt(draft.line2),
      city: opt(draft.city),
      postalCode: opt(draft.postalCode),
      instructions: opt(draft.instructions),
    };
  };
  const field = (key: keyof DeliveryAddressView, label: string, placeholder: string, wide = false) => (
    <label className={'block ' + (wide ? 'col-span-2' : '')}>
      <span className="text-xs font-medium text-slate-600">{label}</span>
      <input
        value={draft[key] ?? ''}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        placeholder={placeholder}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="mb-1 font-semibold">Delivery address</h2>
      <p className="mb-3 text-xs text-slate-500">
        Saved from their last delivery and offered back on their next call.
      </p>
      {editing ? (
        <div>
          <div className="grid grid-cols-2 gap-3">
            {field('line1', 'Street address', '12 Main Street', true)}
            {field('line2', 'Apt / unit', 'Apt 2')}
            {field('postalCode', 'ZIP', '12866')}
            {field('city', 'City', 'Saratoga Springs', true)}
            {field('instructions', 'For the driver', 'Side door, ring twice', true)}
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={() => {
                const next = cleaned();
                if (next) void submit(next);
                else setError('Enter the street number and street.');
              }}
              disabled={busy}
              className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save address'}
            </button>
            <button onClick={() => setEditing(false)} className="text-sm text-slate-500 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : address ? (
        <div className="text-sm">
          <div className="text-slate-700">{addressLine(address)}</div>
          {address.instructions && <div className="text-slate-500">{address.instructions}</div>}
          {updatedAt && <div className="mt-1 text-xs text-slate-400">Saved {fmtDate(updatedAt)}</div>}
          {canManage && (
            <div className="mt-3 flex gap-4">
              <button onClick={begin} className="text-sm font-medium text-brayz hover:underline">
                Edit
              </button>
              <button
                onClick={() => void submit(null)}
                disabled={busy}
                className="text-sm text-red-600 hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="text-sm text-slate-400">
          No saved address.{' '}
          {canManage && (
            <button onClick={begin} className="font-medium text-brayz hover:underline">
              Add one
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}

function GuestDetailPanel({
  id,
  canManage,
  onDeleted,
}: {
  id: string;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const { api, activeTenantId, activeLocationId } = useAuth();
  const qc = useQueryClient();
  const guest = useGuest(id);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [bMonth, setBMonth] = useState<number | ''>('');
  const [bDay, setBDay] = useState<number | ''>('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (guest.data) {
      setName(guest.data.displayName ?? '');
      setNotes(guest.data.notes ?? '');
      setBMonth(guest.data.birthdayMonth ?? '');
      setBDay(guest.data.birthdayDay ?? '');
    }
  }, [guest.data]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['guest', activeTenantId, id] });
    qc.invalidateQueries({ queryKey: ['guests', activeTenantId, activeLocationId] });
  };
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api(`/v1/guests/${id}`, { method: 'PATCH', body }),
    onSuccess: invalidate,
  });
  const del = useMutation({
    mutationFn: () => api(`/v1/guests/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidate();
      onDeleted();
    },
  });

  if (guest.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!guest.data) return <p className="text-slate-500">Guest not found.</p>;
  const g = guest.data;

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="mb-4 flex items-center gap-2 font-semibold">
          Profile
          {g.vip && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              VIP
            </span>
          )}
        </h2>
        <div className="space-y-3">
          <label className="block">
            <span className="text-sm font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canManage}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>
          <div className="text-sm text-slate-500">
            {g.phones.length ? g.phones.join(', ') : 'No phone numbers'}
          </div>
          <label className="block">
            <span className="text-sm font-medium">Notes / preferences</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={!canManage}
              rows={3}
              placeholder="e.g. allergic to nuts, likes thin crust"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">Birthday</span>
            <select
              value={bMonth}
              disabled={!canManage}
              onChange={(e) => setBMonth(e.target.value ? Number(e.target.value) : '')}
              className="rounded border border-slate-300 px-2 py-1"
            >
              <option value="">Month</option>
              {['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => (
                <option key={m} value={i + 1}>{m}</option>
              ))}
            </select>
            <select
              value={bDay}
              disabled={!canManage}
              onChange={(e) => setBDay(e.target.value ? Number(e.target.value) : '')}
              className="rounded border border-slate-300 px-2 py-1"
            >
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, i) => (
                <option key={i + 1} value={i + 1}>{i + 1}</option>
              ))}
            </select>
            <span className="text-xs text-slate-500">(for the birthday offer; no year stored)</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={g.memoryEnabled}
              disabled={!canManage || save.isPending}
              onChange={(e) => save.mutate({ memoryEnabled: e.target.checked })}
            />
            Guest memory enabled (uncheck to stop personalizing for this guest)
          </label>
        </div>
        {canManage && (
          <button
            onClick={() =>
              save.mutate({
                displayName: name.trim() || null,
                notes: notes.trim() || null,
                birthdayMonth: bMonth === '' ? null : bMonth,
                birthdayDay: bDay === '' ? null : bDay,
              })
            }
            disabled={save.isPending}
            className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save profile'}
          </button>
        )}
      </section>

      <SavedAddressSection
        address={g.deliveryAddress}
        updatedAt={g.deliveryAddressUpdatedAt}
        canManage={canManage}
        onSave={(deliveryAddress) => save.mutateAsync({ deliveryAddress })}
      />

      {g.loyalty && (
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 font-semibold">Loyalty</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className={statLabelClass}>Points balance</p>
              <p className={`mt-2 ${statValueClass}`}>{g.loyalty.pointsBalance.toLocaleString()}</p>
            </div>
            <div>
              <p className={statLabelClass}>Lifetime points</p>
              <p className={`mt-2 ${statValueClass}`}>{g.loyalty.lifetimePoints.toLocaleString()}</p>
            </div>
            <div>
              <p className={statLabelClass}>Lifetime spend</p>
              <p className={`mt-2 ${statValueClass}`}>{formatMoney(g.loyalty.lifetimeSpendCents)}</p>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="mb-4 font-semibold">Order history</h2>
        {g.orders.length === 0 ? (
          <p className="text-sm text-slate-400">No orders yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {g.orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between py-2">
                <span className="text-slate-700">
                  <span className="font-mono text-xs text-slate-500">#{o.code}</span>{' '}
                  {o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                </span>
                <span className="whitespace-nowrap text-slate-500">
                  {fmtDate(o.createdAt)} · {formatMoney(o.totalCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage && (
        <section className="rounded-xl border border-red-200 bg-red-50/40 p-6">
          <h2 className="mb-1 font-semibold text-red-700">Delete guest</h2>
          <p className="mb-3 text-sm text-slate-600">
            Permanently delete this guest profile and saved memory (right to be forgotten). Their past
            calls and orders are kept but un-linked. This can’t be undone.
          </p>
          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <button
                onClick={() => del.mutate()}
                disabled={del.isPending}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {del.isPending ? 'Deleting…' : 'Confirm delete'}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm text-slate-500 hover:underline">
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
            >
              Delete guest
            </button>
          )}
        </section>
      )}
    </div>
  );
}
