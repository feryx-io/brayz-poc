'use client';

import { useState } from 'react';
import { DuplicateWarning, duplicateFindings, type DuplicateFinding } from '@/components/DuplicateWarning';
import { normalizePhone } from '@/lib/phone';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { HoursEditor, type HoursInterval } from '@/components/HoursEditor';
import { NumberPicker } from '@/components/NumberPicker';

type Step = 1 | 2 | 3 | 4 | 5;

/**
 * Guided setup: business → location/address → hours → Brayz number → done.
 * Holds its own step state and only calls refreshMe()/invalidates at the end, so
 * the app layout keeps rendering the wizard until setup completes.
 *
 * `resumeTenantId` resumes setup for an EXISTING tenant that has no location yet
 * (starts at the location step instead of creating a new business).
 */
export function SetupWizard({ resumeTenantId }: { resumeTenantId?: string | null } = {}) {
  const { api, setActiveTenant, refreshMe } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>(resumeTenantId ? 2 : 1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateFinding[] | null>(null);

  // Collected across steps.
  const [tenantName, setTenantName] = useState('');
  const [tenantId, setTenantId] = useState<string | null>(resumeTenantId ?? null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [loc, setLoc] = useState({
    name: '',
    timezone: 'America/New_York',
    addressLine1: '',
    city: '',
    region: '',
    postalCode: '',
    mainPhone: '',
  });
  const [intervals, setIntervals] = useState<HoursInterval[]>([]);

  const areaCode = loc.mainPhone.replace(/\D/g, '').replace(/^1/, '').slice(0, 3) || undefined;

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const findings = duplicateFindings(err);
      if (findings) setDuplicates(findings);
      else setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  const submitBusiness = () =>
    run(async () => {
      const tenant = await api<{ id: string }>('/v1/tenants', { method: 'POST', body: { name: tenantName } });
      setTenantId(tenant.id);
      setActiveTenant(tenant.id); // sends x-brayz-tenant-id on subsequent calls
      setStep(2);
    });

  // The sign-up checks may answer 409 with findings; the owner reads them and
  // may continue (acknowledged), unless a claimed phone number blocks.
  const submitLocation = (acknowledgeDuplicates = false) =>
    run(async () => {
      setDuplicates(null);
      const created = await api<{ id: string }>('/v1/locations', {
        method: 'POST',
        body: {
          tenantId,
          name: loc.name,
          timezone: loc.timezone,
          addressLine1: loc.addressLine1 || undefined,
          city: loc.city || undefined,
          region: loc.region || undefined,
          postalCode: loc.postalCode || undefined,
          mainPhone: loc.mainPhone ? normalizePhone(loc.mainPhone) : undefined,
          acknowledgeDuplicates: acknowledgeDuplicates || undefined,
        },
      });
      setLocationId(created.id);
      setStep(3);
    });

  const submitHours = () =>
    run(async () => {
      await api(`/v1/locations/${locationId}/hours`, { method: 'PUT', body: { intervals } });
      setStep(4);
    });

  const finish = () =>
    run(async () => {
      await refreshMe(); // memberships populate (new account)
      await qc.invalidateQueries({ queryKey: ['locations'] }); // location now exists → layout shows the app
      router.push('/app/dashboard');
    });

  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-6 py-10">
      <Stepper step={step} />

      {step === 1 && (
        <Card title="Welcome to Brayz 👋" subtitle="Let’s set up your restaurant.">
          <Field label="Restaurant / business name">
            <input className={inputCls} value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Mario's Pizza" />
          </Field>
          <Actions error={error}>
            <Primary disabled={busy || !tenantName.trim()} onClick={submitBusiness}>
              {busy ? 'Creating…' : 'Continue'}
            </Primary>
          </Actions>
        </Card>
      )}

      {step === 2 && (
        <Card title="Your first location" subtitle="Where is this restaurant?">
          <Field label="Location name">
            <input className={inputCls} value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} placeholder="Mario's Pizza — Albany" />
          </Field>
          <Field label="Street address">
            <input className={inputCls} value={loc.addressLine1} onChange={(e) => setLoc({ ...loc, addressLine1: e.target.value })} placeholder="123 Main St" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="City"><input className={inputCls} value={loc.city} onChange={(e) => setLoc({ ...loc, city: e.target.value })} /></Field>
            <Field label="State"><input className={inputCls} value={loc.region} maxLength={2} onChange={(e) => setLoc({ ...loc, region: e.target.value.toUpperCase() })} placeholder="NY" /></Field>
            <Field label="ZIP"><input className={inputCls} value={loc.postalCode} onChange={(e) => setLoc({ ...loc, postalCode: e.target.value })} /></Field>
          </div>
          <Field label="Main phone (your existing number)">
            <input className={inputCls} value={loc.mainPhone} onChange={(e) => setLoc({ ...loc, mainPhone: e.target.value })} placeholder="+15185551234" />
          </Field>
          <Field label="Time zone">
            <input className={inputCls} value={loc.timezone} onChange={(e) => setLoc({ ...loc, timezone: e.target.value })} />
          </Field>
          {duplicates && <DuplicateWarning findings={duplicates} busy={busy} onContinue={() => submitLocation(true)} />}
          <Actions error={error}>
            {!resumeTenantId && <Secondary onClick={() => setStep(1)}>Back</Secondary>}
            <Primary disabled={busy || !loc.name.trim()} onClick={() => submitLocation(false)}>
              {busy ? 'Saving…' : 'Continue'}
            </Primary>
          </Actions>
        </Card>
      )}

      {step === 3 && (
        <Card title="Hours of operation" subtitle="When are you open? You can fine-tune this later.">
          <HoursEditor onChange={setIntervals} />
          <Actions error={error}>
            <Secondary onClick={() => setStep(2)}>Back</Secondary>
            <Primary disabled={busy} onClick={submitHours}>{busy ? 'Saving…' : 'Continue'}</Primary>
          </Actions>
        </Card>
      )}

      {step === 4 && (
        <Card title="Get a Brayz phone number" subtitle="Pick a number for Brayz to answer. Forward your main line to it, or use it directly.">
          {locationId && (
            <NumberPicker
              locationId={locationId}
              defaultAreaCode={areaCode}
              defaultRegion={loc.region || undefined}
              onProvisioned={() => setStep(5)}
            />
          )}
          <Actions error={error}>
            <Secondary onClick={() => setStep(3)}>Back</Secondary>
            <button className="text-sm text-slate-500 hover:text-brayz" onClick={() => setStep(5)}>
              Skip for now
            </button>
          </Actions>
        </Card>
      )}

      {step === 5 && (
        <Card title="You’re all set 🎉" subtitle="Your restaurant is ready. You can refine everything in Settings.">
          <Actions error={error}>
            <Primary disabled={busy} onClick={finish}>{busy ? 'Finishing…' : 'Go to dashboard'}</Primary>
          </Actions>
        </Card>
      )}
    </main>
  );
}

const inputCls = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2';

function Stepper({ step }: { step: Step }) {
  const labels = ['Business', 'Location', 'Hours', 'Number', 'Done'];
  return (
    <ol className="mb-8 flex items-center gap-2 text-xs">
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                'flex h-6 w-6 items-center justify-center rounded-full font-medium ' +
                (done ? 'bg-brayz text-white' : active ? 'bg-brayz/15 text-brayz-dark' : 'bg-slate-100 text-slate-400')
              }
            >
              {done ? '✓' : n}
            </span>
            <span className={active ? 'font-medium text-slate-700' : 'text-slate-400'}>{label}</span>
            {n < 5 && <span className="text-slate-300">·</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="text-2xl font-bold">{title}</h1>
      {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function Actions({ error, children }: { error: string | null; children: React.ReactNode }) {
  return (
    <div>
      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">{children}</div>
    </div>
  );
}

function Primary({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className="rounded-lg bg-brayz px-5 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function Secondary({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...props} className="rounded-lg border border-slate-300 px-4 py-2 font-medium text-slate-700 hover:bg-slate-50">
      {children}
    </button>
  );
}
