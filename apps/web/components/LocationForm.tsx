'use client';

import { useState } from 'react';

export interface LocationFormValues {
  name: string;
  timezone: string;
  addressLine1?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  mainPhone?: string;
}

/** Shared restaurant-location form — used by the setup wizard and "Add location". */
export function LocationForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<LocationFormValues>;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (values: LocationFormValues) => void;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<LocationFormValues>({
    name: initial?.name ?? '',
    timezone: initial?.timezone ?? 'America/New_York',
    addressLine1: initial?.addressLine1 ?? '',
    city: initial?.city ?? '',
    region: initial?.region ?? '',
    postalCode: initial?.postalCode ?? '',
    mainPhone: initial?.mainPhone ?? '',
  });
  const set = (patch: Partial<LocationFormValues>) => setV((cur) => ({ ...cur, ...patch }));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (v.name.trim()) onSubmit(v);
      }}
      className="space-y-4"
    >
      <Field label="Location name">
        <input className={cls} value={v.name} onChange={(e) => set({ name: e.target.value })} placeholder="Jimmy's Pizza — Glens Falls" />
      </Field>
      <Field label="Street address">
        <input className={cls} value={v.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} placeholder="123 Main St" />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="City"><input className={cls} value={v.city} onChange={(e) => set({ city: e.target.value })} /></Field>
        <Field label="State"><input className={cls} value={v.region} maxLength={2} onChange={(e) => set({ region: e.target.value.toUpperCase() })} placeholder="NY" /></Field>
        <Field label="ZIP"><input className={cls} value={v.postalCode} onChange={(e) => set({ postalCode: e.target.value })} /></Field>
      </div>
      <Field label="Main phone (your existing number)">
        <input className={cls} value={v.mainPhone} onChange={(e) => set({ mainPhone: e.target.value })} placeholder="+15185551234" />
      </Field>
      <Field label="Time zone">
        <input className={cls} value={v.timezone} onChange={(e) => set({ timezone: e.target.value })} />
      </Field>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy || !v.name.trim()}
          className="rounded-lg bg-brayz px-5 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          {busy ? 'Saving…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="text-sm text-slate-500 hover:text-brayz">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

const cls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
