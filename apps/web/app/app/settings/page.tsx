'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { normalizePhone } from '@/lib/phone';
import { DuplicateWarning, duplicateFindings } from '@/components/DuplicateWarning';
import {
  formatMoney,
  useBilling,
  useLocations,
  usePosIntegration,
  type AiSettings,
  type HolidayEntry,
  type BillingPlanId,
  type Location,
  type LocationBilling,
  type PosIntegration,
} from '@/lib/queries';
import { NumberPicker } from '@/components/NumberPicker';
import { TextAlertsCard } from '@/components/TextAlertsCard';
import { statLabelClass, statValueClass } from '@/components/StatCard';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toHHMM = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const fromHHMM = (s: string) => {
  const [h, m] = s.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

interface DayHours {
  enabled: boolean;
  opensAt: number;
  closesAt: number;
}
interface PhoneNumber {
  id: string;
  e164Number: string;
  inboundRouteType: string;
}
interface TransferTarget {
  id: string;
  key: string;
  label: string;
  description?: string | null;
  destination: string;
  enabled: boolean;
  sortOrder: number;
}

export default function SettingsPage() {
  const { api, activeTenantId, activeLocationId, setActiveLocation, canManage, memberships, refreshMe } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const locationId = activeLocationId ?? locations.data?.[0]?.id;
  const tenantName = memberships.find((m) => m.tenantId === activeTenantId)?.tenantName ?? '';

  const detail = useQuery({
    queryKey: ['location', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () =>
      api<Location & { hours: Array<{ dayOfWeek: number; opensAt: number; closesAt: number }> }>(
        `/v1/locations/${locationId}`,
      ),
  });
  const phones = useQuery({
    queryKey: ['phones', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<PhoneNumber[]>(`/v1/locations/${locationId}/phone-numbers`),
  });
  const aiSettings = useQuery({
    queryKey: ['ai-settings', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<AiSettings>(`/v1/locations/${locationId}/ai-settings`),
  });
  const holidays = useQuery({
    queryKey: ['holidays', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () =>
      api<Array<HolidayEntry & { date: string }>>(`/v1/locations/${locationId}/holiday-hours`),
  });
  const transferTargets = useQuery({
    queryKey: ['transfer-targets', activeTenantId, locationId],
    enabled: !!locationId,
    queryFn: () => api<TransferTarget[]>(`/v1/locations/${locationId}/transfer-targets`),
  });
  const pos = usePosIntegration(locationId);
  const billing = useBilling(locationId);

  if (locations.isLoading || detail.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!locationId || !detail.data)
    return <p className="text-slate-500">No location found.</p>;

  return (
    <div className="max-w-2xl space-y-10">
      <h1 className="text-2xl font-bold">Settings</h1>
      {!canManage && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600">
          You have view-only access. Editing requires a manager or owner role.
        </p>
      )}

      <BusinessSection
        name={tenantName}
        canManage={canManage}
        onSave={async (name) => {
          await api(`/v1/tenants/${activeTenantId}`, { method: 'PATCH', body: { name } });
          await refreshMe(); // updates the header + tenant switcher
        }}
      />

      <ProfileForm
        location={detail.data}
        canManage={canManage}
        onSave={async (patch) => {
          await api(`/v1/locations/${locationId}`, { method: 'PATCH', body: patch });
          qc.invalidateQueries({ queryKey: ['location'] });
          qc.invalidateQueries({ queryKey: ['locations'] });
        }}
      />

      <TextAlertsCard locationId={locationId} canManage={canManage} />

      <FulfillmentSection
        location={detail.data}
        canManage={canManage}
        onSave={async (patch) => {
          await api(`/v1/locations/${locationId}`, { method: 'PATCH', body: patch });
          qc.invalidateQueries({ queryKey: ['location'] });
          qc.invalidateQueries({ queryKey: ['locations'] });
        }}
      />

      <HoursEditor
        initial={detail.data.hours}
        canManage={canManage}
        onSave={async (intervals) => {
          await api(`/v1/locations/${locationId}/hours`, { method: 'PUT', body: { intervals } });
          qc.invalidateQueries({ queryKey: ['location'] });
        }}
      />

      <HolidaySection
        initial={(holidays.data ?? []).map((h) => ({ ...h, date: h.date.slice(0, 10) }))}
        canManage={canManage}
        onSave={async (entries) => {
          await api(`/v1/locations/${locationId}/holiday-hours`, { method: 'PUT', body: { entries } });
          qc.invalidateQueries({ queryKey: ['holidays'] });
        }}
      />

      <ClosedHoursSection
        initial={aiSettings.data}
        canManage={canManage}
        onSave={async (patch) => {
          await api(`/v1/locations/${locationId}/ai-settings`, { method: 'PUT', body: patch });
          qc.invalidateQueries({ queryKey: ['ai-settings'] });
        }}
      />

      <AiSettingsSection
        initial={aiSettings.data}
        canManage={canManage}
        onSave={async (patch) => {
          await api(`/v1/locations/${locationId}/ai-settings`, { method: 'PUT', body: patch });
          qc.invalidateQueries({ queryKey: ['ai-settings'] });
        }}
      />


      <BillingSection
        billing={billing.data}
        loading={billing.isLoading}
        canManage={canManage}
        onCheckout={(plan) =>
          api<{ url: string }>(`/v1/locations/${locationId}/billing/checkout`, {
            method: 'POST',
            body: { plan, returnUrl: window.location.href },
          })
        }
        onPortal={() =>
          api<{ url: string }>(`/v1/locations/${locationId}/billing/portal`, {
            method: 'POST',
            body: { returnUrl: window.location.href },
          })
        }
      />

      <PosSection
        initial={pos.data}
        canManage={canManage}
        onSave={async (body) => {
          await api(`/v1/locations/${locationId}/pos`, { method: 'PUT', body });
          qc.invalidateQueries({ queryKey: ['pos-integration'] });
          qc.invalidateQueries({ queryKey: ['orders'] });
        }}
        onDisconnect={async () => {
          await api(`/v1/locations/${locationId}/pos`, { method: 'DELETE' });
          qc.invalidateQueries({ queryKey: ['pos-integration'] });
        }}
      />

      <TransferTargetsSection
        targets={transferTargets.data ?? []}
        canManage={canManage}
        onCreate={async (t) => {
          await api(`/v1/locations/${locationId}/transfer-targets`, { method: 'POST', body: t });
          qc.invalidateQueries({ queryKey: ['transfer-targets'] });
        }}
        onUpdate={async (id, patch) => {
          await api(`/v1/transfer-targets/${id}`, { method: 'PATCH', body: patch });
          qc.invalidateQueries({ queryKey: ['transfer-targets'] });
        }}
        onDelete={async (id) => {
          await api(`/v1/transfer-targets/${id}`, { method: 'DELETE' });
          qc.invalidateQueries({ queryKey: ['transfer-targets'] });
        }}
      />

      <PhonesSection
        phones={phones.data ?? []}
        canManage={canManage}
        locationId={locationId}
        region={detail.data?.region ?? undefined}
        onProvisioned={() => qc.invalidateQueries({ queryKey: ['phones'] })}
        onAdd={async (e164Number) => {
          await api(`/v1/locations/${locationId}/phone-numbers`, {
            method: 'POST',
            body: { e164Number },
          });
          qc.invalidateQueries({ queryKey: ['phones'] });
        }}
        onDelete={async (id) => {
          await api(`/v1/phone-numbers/${id}`, { method: 'DELETE' });
          qc.invalidateQueries({ queryKey: ['phones'] });
        }}
      />

      {canManage && (
        <DeleteLocationSection
          locationName={detail.data.name}
          onDelete={async () => {
            await api(`/v1/locations/${locationId}`, { method: 'DELETE' });
            setActiveLocation(null); // layout reconciles to another location (or the add-location wizard)
            await qc.invalidateQueries({ queryKey: ['locations'] });
          }}
        />
      )}
    </div>
  );
}

function DeleteLocationSection({
  locationName,
  onDelete,
}: {
  locationName: string;
  onDelete: () => Promise<void>;
}) {
  const [confirmText, setConfirmText] = useState('');
  const del = useMutation({ mutationFn: onDelete });
  return (
    <section className="rounded-xl border border-red-200 bg-red-50/40 p-6">
      <h2 className="mb-1 font-semibold text-red-700">Danger zone</h2>
      <p className="mb-3 text-sm text-slate-600">
        Permanently delete <span className="font-medium">{locationName}</span> and everything under it —
        menu, hours, call history, and phone numbers. This can’t be undone. Type the location name to confirm.
      </p>
      <div className="flex items-center gap-2">
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={locationName}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          onClick={() => del.mutate()}
          disabled={del.isPending || confirmText.trim() !== locationName}
          className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
        >
          {del.isPending ? 'Deleting…' : 'Delete location'}
        </button>
      </div>
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="mb-4 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function BusinessSection({
  name,
  canManage,
  onSave,
}: {
  name: string;
  canManage: boolean;
  onSave: (name: string) => Promise<void>;
}) {
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(false);
  useEffect(() => setValue(name), [name]);
  const save = useMutation({
    mutationFn: () => onSave(value.trim()),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  return (
    <Section title="Business">
      <p className="mb-2 text-sm text-slate-500">
        Your business name — shown across the dashboard and the restaurant switcher.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim() && value.trim() !== name) save.mutate();
        }}
        className="flex items-center gap-2"
      >
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canManage}
          className="flex-1 rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-50"
        />
        {canManage && (
          <button
            disabled={save.isPending || !value.trim() || value.trim() === name}
            className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        )}
        {saved && <span className="text-sm text-green-600">Saved</span>}
      </form>
    </Section>
  );
}

/** Cents as an owner edits them: "3.50". */
const centsToDollars = (c: number) => (c / 100).toFixed(2);
/** What an owner typed ("3.5", "$3.50") in cents; blank or nonsense is 0. */
const dollarsToCents = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

function fulfillmentForm(l: Location) {
  return {
    pickupEnabled: l.pickupEnabled,
    deliveryEnabled: l.deliveryEnabled,
    pickupEta: String(l.pickupEtaMinutes ?? 20),
    deliveryEta: String(l.deliveryEtaMinutes ?? 45),
    fee: centsToDollars(l.deliveryFeeCents ?? 0),
    minimum: centsToDollars(l.deliveryMinimumCents ?? 0),
    radius: l.deliveryRadiusMiles != null ? String(l.deliveryRadiusMiles) : '',
    zips: (l.deliveryZipCodes ?? []).join(', '),
  };
}

/**
 * Pickup and delivery: which the AI offers, the times it quotes, and what
 * delivery costs and where it goes. The fee and minimum are charged and
 * enforced by the API (rule #5) — the AI only says them. An address is in the
 * delivery area when it is within the radius OR its ZIP is listed; set neither
 * and delivery goes anywhere.
 */
function FulfillmentSection({
  location,
  canManage,
  onSave,
}: {
  location: Location;
  canManage: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  type Form = ReturnType<typeof fulfillmentForm>;
  const [form, setForm] = useState<Form>(() => fulfillmentForm(location));
  const [saved, setSaved] = useState(false);
  useEffect(() => setForm(fulfillmentForm(location)), [location]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  const minutes = (s: string) => Math.round(Number(s));
  const minutesOk = (s: string) => Number.isFinite(Number(s)) && minutes(s) >= 5 && minutes(s) <= 240;
  const radius = form.radius.trim() ? Number(form.radius) : null;
  const radiusOk = radius === null || (Number.isFinite(radius) && radius >= 0.5 && radius <= 50);
  const zips = form.zips.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean);
  const nothingOffered = !form.pickupEnabled && !form.deliveryEnabled;
  const valid =
    !nothingOffered && minutesOk(form.pickupEta) && minutesOk(form.deliveryEta) && radiusOk;

  const save = useMutation({
    mutationFn: () =>
      onSave({
        pickupEnabled: form.pickupEnabled,
        deliveryEnabled: form.deliveryEnabled,
        pickupEtaMinutes: minutes(form.pickupEta),
        deliveryEtaMinutes: minutes(form.deliveryEta),
        deliveryFeeCents: dollarsToCents(form.fee),
        deliveryMinimumCents: dollarsToCents(form.minimum),
        deliveryRadiusMiles: radius,
        deliveryZipCodes: zips,
      }),
    onSuccess: () => {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  // The radius is measured from the restaurant, which has to be found on the
  // map first; until it is, only the ZIP list can say yes.
  const unplaced = (location.deliveryRadiusMiles ?? 0) > 0 && location.latitude == null;
  const origin = [location.addressLine1, location.city].filter(Boolean).join(', ');

  return (
    <Section title="Pickup & delivery">
      <div className="space-y-2 text-sm">
        <Check
          label="Take pickup orders"
          checked={form.pickupEnabled}
          onChange={() => set('pickupEnabled', !form.pickupEnabled)}
        />
        <Check
          label="Take delivery orders"
          checked={form.deliveryEnabled}
          onChange={() => set('deliveryEnabled', !form.deliveryEnabled)}
        />
      </div>
      {nothingOffered && (
        <p className="mt-2 text-xs text-red-600">
          Turn at least one on — with both off the AI cannot take an order.
        </p>
      )}
      <p className="mt-2 text-xs text-slate-500">
        With both on, the AI asks every caller &ldquo;Is this for pickup or delivery?&rdquo;
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Input
          label="Pickup ready in (minutes)"
          value={form.pickupEta}
          onChange={(v) => set('pickupEta', v)}
          placeholder="20"
        />
        {form.deliveryEnabled && (
          <Input
            label="Delivery arrives in (minutes)"
            value={form.deliveryEta}
            onChange={(v) => set('deliveryEta', v)}
            placeholder="45"
          />
        )}
      </div>
      {(!minutesOk(form.pickupEta) || !minutesOk(form.deliveryEta)) && (
        <p className="mt-1 text-xs text-red-600">Times are in minutes, between 5 and 240.</p>
      )}

      {form.deliveryEnabled && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Input
              label="Delivery fee ($)"
              value={form.fee}
              onChange={(v) => set('fee', v)}
              placeholder="0.00"
            />
            <Input
              label="Minimum order ($, before the fee)"
              value={form.minimum}
              onChange={(v) => set('minimum', v)}
              placeholder="0.00"
            />
          </div>

          <h3 className="mt-5 text-sm font-semibold">Delivery area</h3>
          <p className="text-xs text-slate-500">
            An address qualifies if it is within the radius or its ZIP code is listed. Leave both
            empty to deliver anywhere.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <Input
              label="Radius (miles, straight line)"
              value={form.radius}
              onChange={(v) => set('radius', v)}
              placeholder="5"
            />
            <Input
              label="ZIP codes"
              value={form.zips}
              onChange={(v) => set('zips', v)}
              placeholder="12866, 12831"
            />
          </div>
          {!radiusOk && (
            <p className="mt-1 text-xs text-red-600">The radius must be between 0.5 and 50 miles.</p>
          )}
          {radius !== null && radiusOk && (
            <p className="mt-1 text-xs text-slate-500">
              Measured from {origin || 'your address — add it under Restaurant profile'}.
            </p>
          )}
          {unplaced && (
            <p className="mt-1 text-xs text-amber-700">
              We could not find your address on the map yet, so the radius cannot be checked. Delivery
              orders are still taken and marked &ldquo;not checked&rdquo; on the ticket, and listed ZIP
              codes still work. Check the address, state and ZIP under Restaurant profile.
            </p>
          )}
        </>
      )}

      {canManage && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!valid || save.isPending}
            className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-green-600">Saved</span>}
          {save.isError && <span className="text-sm text-red-600">{(save.error as Error).message}</span>}
        </div>
      )}
    </Section>
  );
}

function ProfileForm({
  location,
  canManage,
  onSave,
}: {
  location: Location;
  canManage: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState(location);
  useEffect(() => setForm(location), [location]);
  const set = (k: keyof Location, v: unknown) => setForm((f) => ({ ...f, [k]: v }));

  // Send only editable fields, phones normalized to E.164, blanks as null (clear).
  const buildPatch = (): Record<string, unknown> => {
    const keys: Array<keyof Location> = [
      'name',
      'timezone',
      'addressLine1',
      'city',
      'region',
      'postalCode',
      'mainPhone',
      'escalationPhone',
      'aiGreetings',
      'welcomeBackLines',
    ];
    const phones: Array<keyof Location> = ['mainPhone', 'escalationPhone'];
    const patch: Record<string, unknown> = {};
    for (const k of keys) {
      const v = form[k];
      if (v === undefined) continue;
      // Line lists: blank lines dropped; an empty list is the default behaviour.
      if (Array.isArray(v)) {
        patch[k] = v.map((line) => line.trim()).filter(Boolean);
        continue;
      }
      // A blanked optional field clears it (null); name and timezone can't be blank.
      if (typeof v === 'string' && v.trim() === '') {
        if (k !== 'name' && k !== 'timezone') patch[k] = null;
        continue;
      }
      // Owners type "(518) 555-1234"; the API wants +15185551234.
      patch[k] = typeof v === 'string' && phones.includes(k) ? normalizePhone(v) : v;
    }
    return patch;
  };
  const save = useMutation({
    mutationFn: (acknowledgeDuplicates: boolean) =>
      onSave(acknowledgeDuplicates ? { ...buildPatch(), acknowledgeDuplicates: true } : buildPatch()),
  });
  const duplicates = save.isError ? duplicateFindings(save.error) : null;

  return (
    <Section title="Restaurant profile">
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Location name"
          value={form.name ?? ''}
          onChange={(v) => set('name', v)}
          placeholder="Jimmy's Pizza - Saratoga"
        />
        <Input label="Time zone" value={form.timezone ?? ''} onChange={(v) => set('timezone', v)} />
        <Input label="Address" value={form.addressLine1 ?? ''} onChange={(v) => set('addressLine1', v)} />
        <Input label="City" value={form.city ?? ''} onChange={(v) => set('city', v)} />
        <Input label="State" value={form.region ?? ''} onChange={(v) => set('region', v)} placeholder="NY" />
        <Input label="ZIP" value={form.postalCode ?? ''} onChange={(v) => set('postalCode', v)} placeholder="12866" />
        <Input label="Main phone" value={form.mainPhone ?? ''} onChange={(v) => set('mainPhone', v)} placeholder="+15185559898" />
        <Input
          label="Escalation phone"
          value={form.escalationPhone ?? ''}
          onChange={(v) => set('escalationPhone', v)}
          placeholder="+15185550000"
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Where order and message texts go is set under Text alerts, with the number owner&apos;s consent.
      </p>
      <LineListEditor
        title="AI greetings"
        hint={
          <>
            Spoken word for word when a call is answered. With more than one, a regular hears the next line each
            time they call and a new caller gets one at random. Write {'{staff_name}'} for whoever is speaking — the
            default voice&apos;s name from Staff Voices, or the staff member whose voice answers. Leave empty for
            &quot;Thanks for calling {form.name || 'us'}. How can I help you today?&quot;
          </>
        }
        lines={form.aiGreetings ?? []}
        placeholder={`Thanks for calling ${form.name || 'us'}. This is {staff_name}. What can I get started for you?`}
        max={8}
        rows={2}
        canManage={canManage}
        onChange={(lines) => set('aiGreetings', lines)}
      />
      <LineListEditor
        title="Welcome-back lines"
        hint={
          <>
            What a recognized regular hears before the greeting, rotated the same way. {'{guest_name}'} is their
            name. Leave empty for the built-in variants (&quot;Welcome back, {'{guest_name}'}!&quot; and friends).
          </>
        }
        lines={form.welcomeBackLines ?? []}
        placeholder="Welcome back, {guest_name}!"
        max={8}
        rows={1}
        canManage={canManage}
        onChange={(lines) => set('welcomeBackLines', lines)}
      />
      <p className="mt-3 text-xs text-slate-500">
        A regular&apos;s first call back hears:{' '}
        <span className="italic text-slate-700">
          “{((form.welcomeBackLines ?? []).find((l) => l.trim()) ?? 'Welcome back, {guest_name}!').split('{guest_name}').join('Dana')}{' '}
          {(form.aiGreetings ?? []).find((l) => l.trim()) ?? `Thanks for calling ${form.name || 'us'}. How can I help you today?`}”
        </span>
      </p>
      <button
        onClick={() => save.mutate(false)}
        disabled={save.isPending || !canManage}
        className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save profile'}
      </button>
      {duplicates && (
        <div className="mt-3">
          <DuplicateWarning findings={duplicates} busy={save.isPending} onContinue={() => save.mutate(true)} />
        </div>
      )}
      {save.isError && !duplicates && (
        <p className="mt-2 text-sm text-red-600">
          {(save.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}
      {save.isSuccess && !save.isPending && <p className="mt-2 text-sm text-emerald-700">Saved.</p>}
    </Section>
  );
}

function HoursEditor({
  initial,
  canManage,
  onSave,
}: {
  initial: Array<{ dayOfWeek: number; opensAt: number; closesAt: number }>;
  canManage: boolean;
  onSave: (intervals: Array<{ dayOfWeek: number; opensAt: number; closesAt: number }>) => Promise<void>;
}) {
  const build = (): DayHours[] =>
    DAYS.map((_, day) => {
      const row = initial.find((h) => h.dayOfWeek === day);
      return row
        ? { enabled: true, opensAt: row.opensAt, closesAt: row.closesAt }
        : { enabled: false, opensAt: 660, closesAt: 1320 };
    });
  const [rows, setRows] = useState<DayHours[]>(build);
  useEffect(() => setRows(build()), [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () =>
      onSave(
        rows
          .map((r, day) => ({ ...r, day }))
          .filter((r) => r.enabled)
          .map((r) => ({ dayOfWeek: r.day, opensAt: r.opensAt, closesAt: r.closesAt })),
      ),
  });

  return (
    <Section title="Business hours">
      <div className="space-y-2">
        {rows.map((r, day) => (
          <div key={day} className="flex items-center gap-3 text-sm">
            <label className="flex w-20 items-center gap-2">
              <input
                type="checkbox"
                checked={r.enabled}
                onChange={(e) =>
                  setRows((rs) => rs.map((x, i) => (i === day ? { ...x, enabled: e.target.checked } : x)))
                }
              />
              {DAYS[day]}
            </label>
            <input
              type="time"
              value={toHHMM(r.opensAt)}
              disabled={!r.enabled}
              onChange={(e) =>
                setRows((rs) => rs.map((x, i) => (i === day ? { ...x, opensAt: fromHHMM(e.target.value) } : x)))
              }
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
            />
            <span>to</span>
            <input
              type="time"
              value={toHHMM(r.closesAt)}
              disabled={!r.enabled}
              onChange={(e) =>
                setRows((rs) => rs.map((x, i) => (i === day ? { ...x, closesAt: fromHHMM(e.target.value) } : x)))
              }
              className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
            />
          </div>
        ))}
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || !canManage}
        className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save hours'}
      </button>
    </Section>
  );
}

function PhonesSection({
  phones,
  canManage,
  locationId,
  region,
  onProvisioned,
  onAdd,
  onDelete,
}: {
  phones: PhoneNumber[];
  canManage: boolean;
  locationId: string;
  region?: string;
  onProvisioned: () => void;
  onAdd: (e164: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [e164, setE164] = useState('');
  const [showManual, setShowManual] = useState(false);
  const add = useMutation({ mutationFn: () => onAdd(e164).then(() => setE164('')) });
  return (
    <Section title="Phone numbers">
      <ul className="mb-4 divide-y divide-slate-100">
        {phones.map((p) => (
          <li key={p.id} className="flex items-center justify-between py-2 text-sm">
            <span className="tabular-nums">{p.e164Number}</span>
            {canManage && (
              <button onClick={() => onDelete(p.id)} className="text-xs text-red-500 hover:underline">
                Remove
              </button>
            )}
          </li>
        ))}
        {phones.length === 0 && <li className="py-2 text-sm text-slate-400">No numbers yet</li>}
      </ul>
      {canManage && (
        <>
          <p className="mb-2 text-sm font-medium text-slate-700">Get a Brayz number</p>
          <NumberPicker locationId={locationId} defaultRegion={region} onProvisioned={onProvisioned} />
          <button
            onClick={() => setShowManual((s) => !s)}
            className="mt-3 text-xs text-slate-500 hover:text-brayz"
          >
            {showManual ? 'Hide' : 'Add an existing number manually'}
          </button>
          {showManual && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (e164.trim()) add.mutate();
              }}
              className="mt-2 flex gap-2"
            >
              <input
                value={e164}
                onChange={(e) => setE164(e.target.value)}
                placeholder="+15185559898"
                className="flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <button
                disabled={add.isPending}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
              >
                Add
              </button>
            </form>
          )}
        </>
      )}
    </Section>
  );
}

/**
 * What happens to a call that lands out of hours, and whether a caller may
 * order for later. Its own card rather than a line in "AI & call handling":
 * until now the bot took an order at four in the morning as happily as at
 * lunchtime, and an owner looking for that would look here, beside the hours.
 */
function ClosedHoursSection({
  initial,
  canManage,
  onSave,
}: {
  initial: AiSettings | undefined;
  canManage: boolean;
  onSave: (patch: AiSettings) => Promise<void>;
}) {
  const [behavior, setBehavior] = useState<'take_orders' | 'announce'>(initial?.closedBehavior ?? 'take_orders');
  const [scheduling, setScheduling] = useState(initial?.scheduleOrdersEnabled ?? false);
  const [daysAhead, setDaysAhead] = useState(initial?.scheduleMaxDaysAhead ?? 1);
  useEffect(() => {
    if (!initial) return;
    setBehavior(initial.closedBehavior ?? 'take_orders');
    setScheduling(initial.scheduleOrdersEnabled ?? false);
    setDaysAhead(initial.scheduleMaxDaysAhead ?? 1);
  }, [initial]);
  const save = useMutation({
    mutationFn: () =>
      onSave({
        closedBehavior: behavior,
        scheduleOrdersEnabled: scheduling,
        scheduleMaxDaysAhead: daysAhead,
      } as AiSettings),
  });

  return (
    <Section title="When you're closed">
      <div className="space-y-3 text-sm">
        <label className="block">
          <span>A call that comes in outside your hours</span>
          <select
            value={behavior}
            onChange={(e) => setBehavior(e.target.value as 'take_orders' | 'announce')}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="take_orders">Answer as usual — take the order anyway</option>
            <option value="announce">Say you&rsquo;re closed, and when you open next</option>
          </select>
          <span className="mt-1 block text-xs text-slate-500">
            Judged against the business hours above, holidays included. A location with no hours
            saved is always treated as open — the AI never turns a caller away on a guess.
          </span>
        </label>

        <Check
          label="Let callers order ahead for a later time"
          checked={scheduling}
          onChange={() => setScheduling((v) => !v)}
        />
        <span className="block text-xs text-slate-500">
          Works whether you&rsquo;re open or closed: &ldquo;can I pick that up at six?&rdquo; as well as an
          order taken overnight for when you open. The time is checked against your hours and your
          pickup wait before it is agreed, and the ticket goes to the kitchen straight away with the
          time on it.
        </span>

        {scheduling && (
          <label className="block">
            <span>How far ahead</span>
            <select
              value={daysAhead}
              onChange={(e) => setDaysAhead(Number(e.target.value))}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
            >
              <option value={0}>Today only</option>
              <option value={1}>Today and tomorrow</option>
              <option value={3}>Up to 3 days ahead</option>
              <option value={7}>Up to a week ahead</option>
            </select>
          </label>
        )}
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || !canManage}
        className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save'}
      </button>
    </Section>
  );
}

function AiSettingsSection({
  initial,
  canManage,
  onSave,
}: {
  initial: AiSettings | undefined;
  canManage: boolean;
  onSave: (patch: AiSettings) => Promise<void>;
}) {
  const fallback: AiSettings = {
    transferEnabled: true,
    transferWhenOpen: true,
    offerMessageWhenClosed: true,
    maxCallSeconds: 600,
    voicePersona: null,
    guestMemoryMode: 'full',
    orderAckMode: 'fast',
    recordingRetentionDays: null,
  };
  const [form, setForm] = useState<AiSettings>(initial ?? fallback);
  const retentionCeiling = initial?.recordingRetentionMaxDays;
  useEffect(() => {
    if (initial) setForm(initial);
  }, [initial]);
  const save = useMutation({ mutationFn: () => onSave(form) });
  const toggle = (k: keyof AiSettings) => setForm((f) => ({ ...f, [k]: !f[k] }));

  return (
    <Section title="AI & call handling">
      <div className="space-y-2 text-sm">
        <Check label="Allow transfer to staff" checked={form.transferEnabled} onChange={() => toggle('transferEnabled')} />
        <Check label="Transfer while open" checked={form.transferWhenOpen} onChange={() => toggle('transferWhenOpen')} />
        <Check
          label="Offer to take a message when closed"
          checked={form.offerMessageWhenClosed}
          onChange={() => toggle('offerMessageWhenClosed')}
        />
        <div>
          <Check
            label="Offer callers a text when their order is ready"
            checked={!!form.guestOrderTextsEnabled}
            onChange={() => toggle('guestOrderTextsEnabled')}
          />
          <span className="mt-1 block text-xs text-slate-500">
            After an order is placed, the AI asks: &ldquo;Would you like a text when your order is ready?&rdquo;,
            with the message-rates and STOP disclosure. Only callers who say yes are texted, once, when the order
            is marked Ready; their answer is recorded on the call. Your business texting registration must cover
            texts to customers before you turn this on.
          </span>
        </div>
        <label className="flex items-center gap-2">
          <span>Max call length (seconds)</span>
          <input
            type="number"
            min={30}
            max={3600}
            value={form.maxCallSeconds}
            onChange={(e) => setForm((f) => ({ ...f, maxCallSeconds: Number(e.target.value) }))}
            className="w-24 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          <span>Voice persona (optional)</span>
          <input
            value={form.voicePersona ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, voicePersona: e.target.value || null }))}
            placeholder="e.g. tony"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block">
          <span>Guest memory (returning callers)</span>
          <select
            value={form.guestMemoryMode ?? 'full'}
            onChange={(e) =>
              setForm((f) => ({ ...f, guestMemoryMode: e.target.value as 'full' | 'confirm' | 'off' }))
            }
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="full">Full — greet by name and offer their usual</option>
            <option value="confirm">Confirm first — greet, but verify before recalling orders</option>
            <option value="off">Off — no personalization from caller ID</option>
          </select>
          <span className="mt-1 block text-xs text-slate-500">
            How much the AI personalizes for a guest it recognizes by phone number. Guests can also opt
            out individually from the Guests page.
          </span>
        </label>
        <label className="block">
          <span>Confirming each item</span>
          <select
            value={form.orderAckMode ?? 'fast'}
            onChange={(e) => setForm((f) => ({ ...f, orderAckMode: e.target.value as 'fast' | 'natural' }))}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="fast">Quick — confirm the moment it goes on the order</option>
            <option value="natural">Conversational — let the AI word it, about a second slower</option>
          </select>
          <span className="mt-1 block text-xs text-slate-500">
            After each item, the caller hears it confirmed. Quick answers straight away in a set
            phrase (&ldquo;Got it &mdash; Large Pizza with Sausage. Anything else?&rdquo;). Conversational
            hands the wording to the AI, which varies it and can tie it to what was just said — but
            the caller waits through a second round of thinking to hear it. Measured at roughly 1.5
            seconds more silence per item. The order read-back before anything is placed is the same
            either way.
          </span>
        </label>
        <label className="block">
          <span>Keep call recordings for (days)</span>
          <input
            type="number"
            min={1}
            max={retentionCeiling}
            step={1}
            value={form.recordingRetentionDays ?? ''}
            placeholder={retentionCeiling ? `${retentionCeiling} (platform default)` : 'platform default'}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                recordingRetentionDays: e.target.value === '' ? null : Number(e.target.value),
              }))
            }
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Recordings older than this are deleted from storage automatically, once an hour, and
            the call shows that a recording existed but was removed. Leave it blank to keep them
            {retentionCeiling ? ` for the platform\u2019s ${retentionCeiling} days` : ' as long as the platform does'}
            &mdash; a location can shorten that, never extend it. Deleting is permanent and is
            written to the audit log.
          </span>
        </label>
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || !canManage}
        className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save AI settings'}
      </button>
    </Section>
  );
}

function HolidaySection({
  initial,
  canManage,
  onSave,
}: {
  initial: HolidayEntry[];
  canManage: boolean;
  onSave: (entries: HolidayEntry[]) => Promise<void>;
}) {
  const [rows, setRows] = useState<HolidayEntry[]>(initial);
  useEffect(() => setRows(initial), [initial]);
  const save = useMutation({ mutationFn: () => onSave(rows) });

  const update = (i: number, patch: Partial<HolidayEntry>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  return (
    <Section title="Holiday hours">
      <div className="space-y-2 text-sm">
        {rows.length === 0 && <p className="text-slate-400">No holiday overrides.</p>}
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              value={r.date}
              onChange={(e) => update(i, { date: e.target.value })}
              className="rounded border border-slate-300 px-2 py-1"
            />
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={r.closed} onChange={(e) => update(i, { closed: e.target.checked })} />
              Closed
            </label>
            <input
              value={r.label ?? ''}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Label (e.g. Christmas)"
              className="flex-1 rounded border border-slate-300 px-2 py-1"
            />
            {canManage && (
              <button
                onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                className="text-xs text-red-500 hover:underline"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={() => setRows((rs) => [...rs, { date: '', closed: true, label: '' }])}
            className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Add holiday
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || rows.some((r) => !r.date)}
            className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save holidays'}
          </button>
        </div>
      )}
    </Section>
  );
}

/** Vendors with an adapter that can actually receive a ticket today. */
const POS_PROVIDERS: Array<{ value: string; label: string; hint: string }> = [
  {
    value: 'manual',
    label: 'No POS — printed ticket & SMS',
    hint: 'Orders stay in Brayz and arrive by text. Nothing else to configure.',
  },
  {
    value: 'square',
    label: 'Square',
    hint: 'Orders are raised on your Square account as pickup or delivery tickets.',
  },
];

function PosSection({
  initial,
  canManage,
  onSave,
  onDisconnect,
}: {
  initial: PosIntegration | undefined;
  canManage: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  const [provider, setProvider] = useState(initial?.provider ?? 'manual');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [externalLocationId, setExternalLocationId] = useState(initial?.externalLocationId ?? '');
  const [environment, setEnvironment] = useState(initial?.environment ?? 'sandbox');
  // Always starts blank: the stored token never comes back from the API, and
  // sending an empty one keeps whatever is already on file.
  const [accessToken, setAccessToken] = useState('');
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  useEffect(() => {
    if (!initial) return;
    setProvider(initial.provider);
    setEnabled(initial.enabled);
    setExternalLocationId(initial.externalLocationId ?? '');
    setEnvironment(initial.environment ?? 'sandbox');
    setAccessToken('');
  }, [initial]);

  const save = useMutation({
    mutationFn: () =>
      onSave({
        provider,
        enabled,
        ...(provider === 'manual'
          ? {}
          : {
              environment,
              externalLocationId: externalLocationId.trim() || undefined,
              // Omitted when blank, which the API reads as "keep the stored one".
              ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
            }),
      }),
  });
  const disconnect = useMutation({
    mutationFn: onDisconnect,
    onSuccess: () => setConfirmingDisconnect(false),
  });

  const needsCredentials = provider !== 'manual';
  const hasToken = initial?.provider === provider && initial?.hasAccessToken;
  // The API refuses a vendor POS without both, so don't offer a doomed save.
  const missingCredentials =
    needsCredentials && (!externalLocationId.trim() || (!hasToken && !accessToken.trim()));
  const hint = POS_PROVIDERS.find((p) => p.value === provider)?.hint;

  return (
    <Section title="Point of sale">
      <p className="mb-4 text-sm text-slate-500">
        Where an order taken on a call is sent once the guest confirms it. Orders are always saved in
        Brayz first — if the POS is unreachable the order still stands and can be re-sent from the
        Orders page.
      </p>

      <div className="space-y-3 text-sm">
        <label className="block">
          <span className="font-medium">POS</span>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            disabled={!canManage}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            {POS_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
        </label>

        {needsCredentials && (
          <>
            <label className="block">
              <span className="font-medium">Square location ID</span>
              <input
                value={externalLocationId}
                onChange={(e) => setExternalLocationId(e.target.value)}
                placeholder="L4X9EXAMPLE"
                disabled={!canManage}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                From your Square dashboard, under Account &amp; Settings → Locations.
              </span>
            </label>

            <label className="block">
              <span className="font-medium">Access token</span>
              <input
                type="password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={hasToken ? 'Saved — leave blank to keep it' : 'Paste your Square access token'}
                disabled={!canManage}
                autoComplete="off"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
              />
              <span className="mt-1 block text-xs text-slate-500">
                {hasToken
                  ? 'A token is on file. It is never shown again — leave this blank unless you are replacing it.'
                  : 'Stored encrypted and never sent back to this page.'}
              </span>
            </label>

            <label className="block">
              <span className="font-medium">Environment</span>
              <select
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                disabled={!canManage}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="sandbox">Sandbox — test orders only</option>
                <option value="production">Production — real orders</option>
              </select>
            </label>
          </>
        )}

        <Check
          label="Send new orders to this POS"
          checked={enabled}
          onChange={() => canManage && setEnabled((v) => !v)}
        />
      </div>

      {save.isError && (
        <p className="mt-3 text-sm text-red-600">
          {(save.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={save.isPending || !canManage || missingCredentials}
          className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save POS settings'}
        </button>
        {missingCredentials && (
          <span className="text-xs text-slate-500">
            Square needs both a location ID and an access token.
          </span>
        )}
        {save.isSuccess && !save.isPending && (
          <span className="text-xs text-green-600">Saved.</span>
        )}
      </div>

      {initial?.configured && canManage && (
        <div className="mt-6 border-t border-slate-100 pt-4">
          {confirmingDisconnect ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm text-slate-600">
                Disconnect and forget the stored credentials? New orders will stop being sent.
              </span>
              <button
                onClick={() => disconnect.mutate()}
                disabled={disconnect.isPending}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {disconnect.isPending ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                onClick={() => setConfirmingDisconnect(false)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmingDisconnect(true)}
              className="text-sm text-red-600 hover:text-red-700"
            >
              Disconnect POS
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

function TransferTargetsSection({
  targets,
  canManage,
  onCreate,
  onUpdate,
  onDelete,
}: {
  targets: TransferTarget[];
  canManage: boolean;
  onCreate: (t: { key: string; label: string; destination: string; description?: string }) => Promise<void>;
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const empty = { key: '', label: '', destination: '', description: '' };
  const [draft, setDraft] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      onCreate({ ...draft, description: draft.description || undefined }),
    onSuccess: () => setDraft(empty),
  });

  return (
    <Section title="Transfer targets">
      <p className="mb-3 text-sm text-slate-500">
        People or lines the AI can route a caller to — e.g. a manager, the owner by name, or someone to take an
        order. The caller’s request is matched to one of these by its label and “when to use” note.
      </p>
      <div className="space-y-3">
        {targets.length === 0 && <p className="text-sm text-slate-400">No transfer targets yet.</p>}
        {targets.map((t) => (
          <TransferRow key={t.id} target={t} canManage={canManage} onUpdate={onUpdate} onDelete={onDelete} />
        ))}
      </div>
      {canManage && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.key && draft.label && draft.destination) add.mutate();
          }}
          className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4"
        >
          <Input
            label="Key"
            value={draft.key}
            onChange={(v) => setDraft((d) => ({ ...d, key: v.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
            placeholder="manager"
          />
          <Input label="Label (spoken)" value={draft.label} onChange={(v) => setDraft((d) => ({ ...d, label: v }))} placeholder="a manager" />
          <Input
            label="Destination (sip: URI or phone)"
            value={draft.destination}
            onChange={(v) => setDraft((d) => ({ ...d, destination: v }))}
            placeholder="+15185550000 or sip:bob@pbx"
          />
          <Input
            label="When to use (optional)"
            value={draft.description}
            onChange={(v) => setDraft((d) => ({ ...d, description: v }))}
            placeholder="caller wants to escalate"
          />
          <div className="col-span-2">
            <button
              disabled={add.isPending}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {add.isPending ? 'Adding…' : 'Add transfer target'}
            </button>
          </div>
        </form>
      )}
    </Section>
  );
}

function TransferRow({
  target,
  canManage,
  onUpdate,
  onDelete,
}: {
  target: TransferTarget;
  canManage: boolean;
  onUpdate: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [form, setForm] = useState(target);
  useEffect(() => setForm(target), [target]);
  const dirty =
    form.label !== target.label ||
    form.destination !== target.destination ||
    (form.description ?? '') !== (target.description ?? '') ||
    form.enabled !== target.enabled;
  const save = useMutation({
    mutationFn: () =>
      onUpdate(target.id, {
        label: form.label,
        destination: form.destination,
        description: form.description || undefined,
        enabled: form.enabled,
      }),
  });

  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-xs">{target.key}</span>
        <label className="flex items-center gap-1 text-xs">
          <input
            type="checkbox"
            checked={form.enabled}
            disabled={!canManage}
            onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
          />
          Enabled
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Input label="Label" value={form.label} onChange={(v) => setForm((f) => ({ ...f, label: v }))} />
        <Input label="Destination" value={form.destination} onChange={(v) => setForm((f) => ({ ...f, destination: v }))} />
        <div className="col-span-2">
          <Input label="When to use" value={form.description ?? ''} onChange={(v) => setForm((f) => ({ ...f, description: v }))} />
        </div>
      </div>
      {canManage && (
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
            className="rounded-lg bg-brayz px-3 py-1.5 text-xs font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => onDelete(target.id)} className="text-xs text-red-500 hover:underline">
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

/** A short list of lines an owner writes — greetings, welcome-backs — with add/remove. */
function LineListEditor({
  title,
  hint,
  lines,
  placeholder,
  max,
  rows,
  canManage,
  onChange,
}: {
  title: string;
  hint: ReactNode;
  lines: string[];
  placeholder: string;
  max: number;
  rows: number;
  canManage: boolean;
  onChange: (lines: string[]) => void;
}) {
  const update = (i: number, v: string) => onChange(lines.map((l, j) => (j === i ? v : l)));
  const remove = (i: number) => onChange(lines.filter((_, j) => j !== i));
  return (
    <div className="mt-3">
      <span className="text-sm font-medium">{title}</span>
      <span className="block text-xs text-slate-500">{hint}</span>
      <div className="mt-1 space-y-2">
        {lines.map((line, i) => (
          <div key={i} className="flex items-start gap-2">
            <textarea
              value={line}
              onChange={(e) => update(i, e.target.value)}
              rows={rows}
              placeholder={placeholder}
              disabled={!canManage}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm disabled:bg-slate-50"
            />
            {canManage && (
              <button
                type="button"
                onClick={() => remove(i)}
                className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                title="Remove this line"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      {canManage && lines.length < max && (
        <button
          type="button"
          onClick={() => onChange([...lines, ''])}
          className="mt-2 rounded-lg border border-slate-300 px-3 py-1 text-xs font-medium hover:bg-slate-50"
        >
          + Add {lines.length ? 'another' : 'a'} line
        </button>
      )}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

const STATUS_COPY: Record<
  LocationBilling['status'],
  { label: string; tone: string; detail?: string }
> = {
  none: { label: 'No subscription', tone: 'text-slate-500' },
  trialing: { label: 'Trial', tone: 'text-blue-600' },
  active: { label: 'Active', tone: 'text-green-600' },
  past_due: {
    label: 'Payment failed',
    tone: 'text-amber-600',
    detail: 'Your calls keep being answered — update the card to avoid cancellation.',
  },
  canceled: {
    label: 'Canceled',
    tone: 'text-red-600',
    detail: 'Paid features are switched off for this location.',
  },
  incomplete: {
    label: 'Not finished',
    tone: 'text-amber-600',
    detail: 'Checkout was started but never completed.',
  },
};

/**
 * Billing (plan §12.5). Payment happens on Stripe, so this screen only ever
 * sends the owner there and reads back what Stripe told us — there is no card
 * field anywhere in Brayz.
 */
function BillingSection({
  billing,
  loading,
  canManage,
  onCheckout,
  onPortal,
}: {
  billing: LocationBilling | undefined;
  loading: boolean;
  canManage: boolean;
  onCheckout: (plan: BillingPlanId) => Promise<{ url: string }>;
  onPortal: () => Promise<{ url: string }>;
}) {
  const checkout = useMutation({
    mutationFn: onCheckout,
    onSuccess: (res) => {
      window.location.href = res.url;
    },
  });
  const portal = useMutation({
    mutationFn: onPortal,
    onSuccess: (res) => {
      window.location.href = res.url;
    },
  });

  if (loading) {
    return (
      <Section title="Billing">
        <p className="text-sm text-slate-500">Loading…</p>
      </Section>
    );
  }
  if (!billing) return null;

  const status = STATUS_COPY[billing.status];
  const current = billing.plan ? billing.plans.find((p) => p.plan === billing.plan) : null;
  const usedPct =
    billing.usage.includedCalls && billing.usage.includedCalls > 0
      ? Math.min(100, Math.round((billing.usage.calls / billing.usage.includedCalls) * 100))
      : null;
  const error = (checkout.error ?? portal.error) as Error | undefined;

  return (
    <Section title="Billing">
      {!billing.billingAvailable && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600">
          Billing isn’t connected on this deployment, so plans can’t be bought or changed here.
        </p>
      )}

      <div className="flex flex-wrap items-baseline gap-3">
        <span className="text-lg font-semibold">{current?.name ?? 'No plan'}</span>
        {billing.source === 'trial' && billing.trial ? (
          <span className="text-sm font-medium text-violet-700">
            Free trial · {billing.trial.daysLeft} {billing.trial.daysLeft === 1 ? 'day' : 'days'} left
          </span>
        ) : billing.source === 'trial_expired' ? (
          <span className="text-sm font-medium text-red-600">Trial ended</span>
        ) : (
          <span className={'text-sm font-medium ' + status.tone}>{status.label}</span>
        )}
        {billing.cancelAtPeriodEnd && billing.currentPeriodEnd && (
          <span className="text-sm text-amber-600">
            ends {new Date(billing.currentPeriodEnd).toLocaleDateString()}
          </span>
        )}
      </div>
      {billing.source === 'trial' && billing.trial ? (
        <p className="mt-1 text-sm text-slate-500">
          Every Pro feature is on until {new Date(billing.trial.endsAt).toLocaleDateString()}. Choose a plan any
          time — the trial days you have left still count before billing starts.
        </p>
      ) : billing.source === 'trial_expired' ? (
        <p className="mt-1 text-sm text-red-700">
          Your free trial has ended, so Brayz is not answering this location’s calls. Choose a plan to turn it
          back on.
        </p>
      ) : (
        status.detail && <p className="mt-1 text-sm text-slate-500">{status.detail}</p>
      )}
      {!billing.enforced && billing.status !== 'none' && (
        // Say it plainly rather than letting a tier look like it does something
        // it currently doesn't.
        <p className="mt-1 text-xs text-slate-400">
          Plan limits aren’t being enforced on this deployment yet.
        </p>
      )}

      <div className="mt-4 rounded-lg border border-slate-200 p-4">
        <p className="text-sm font-medium">This period</p>
        <div className="mt-3 flex flex-wrap gap-8">
          <div>
            <p className={statLabelClass}>Calls</p>
            <p className={`mt-2 ${statValueClass}`}>
              {billing.usage.calls}
              {billing.usage.includedCalls !== null && (
                <span className="text-sm font-normal text-slate-400">
                  {' '}
                  / {billing.usage.includedCalls}
                </span>
              )}
            </p>
          </div>
          <div>
            <p className={statLabelClass}>AI minutes</p>
            <p className={`mt-2 ${statValueClass}`}>{billing.usage.aiMinutes}</p>
          </div>
          <div>
            <p className={statLabelClass}>Since</p>
            <p className={`mt-2 ${statValueClass}`}>
              {new Date(billing.usage.since).toLocaleDateString()}
            </p>
          </div>
        </div>
        {usedPct !== null && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
            <div
              className={'h-full ' + (usedPct >= 100 ? 'bg-amber-500' : 'bg-brayz')}
              style={{ width: `${usedPct}%` }}
            />
          </div>
        )}
      </div>

      {error && (
        <p className="mt-3 text-sm text-red-600">
          {error.message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}

      <div className="mt-4 space-y-3">
        {billing.plans.map((p) => {
          // During the free trial the location runs on Pro without paying for
          // it, so no plan is "current" and every one can still be chosen.
          const isCurrent = billing.source === 'subscription' && p.plan === billing.plan;
          return (
            <div
              key={p.plan}
              className={
                'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ' +
                (isCurrent ? 'border-brayz bg-brayz/5' : 'border-slate-200')
              }
            >
              <div>
                <p className="font-medium">
                  {p.name}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {formatMoney(p.monthlyCents)}/month per location
                  </span>
                </p>
                <p className="mt-0.5 text-sm text-slate-500">{p.summary}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {p.includedCalls.toLocaleString()} calls included
                </p>
              </div>
              {isCurrent ? (
                <span className="text-sm font-medium text-brayz">Current plan</span>
              ) : (
                canManage &&
                billing.billingAvailable && (
                  <button
                    onClick={() => checkout.mutate(p.plan)}
                    disabled={checkout.isPending || portal.isPending}
                    className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
                  >
                    {checkout.isPending ? 'Opening…' : billing.source === 'subscription' ? 'Switch' : 'Choose'}
                  </button>
                )
              )}
            </div>
          );
        })}
      </div>

      {canManage && billing.billingAvailable && billing.hasCustomer && (
        <button
          onClick={() => portal.mutate()}
          disabled={portal.isPending}
          className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
        >
          {portal.isPending ? 'Opening…' : 'Manage payment & invoices'}
        </button>
      )}
    </Section>
  );
}
