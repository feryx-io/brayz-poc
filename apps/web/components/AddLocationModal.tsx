'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { LocationForm, type LocationFormValues } from '@/components/LocationForm';
import { DuplicateWarning, duplicateFindings, type DuplicateFinding } from '@/components/DuplicateWarning';
import { normalizePhone } from '@/lib/phone';

/** Create a new location for the active tenant, then switch to it. */
export function AddLocationModal({ onClose }: { onClose: () => void }) {
  const { api, activeTenantId, setActiveLocation } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateFinding[] | null>(null);
  const [pending, setPending] = useState<LocationFormValues | null>(null);

  async function onSubmit(v: LocationFormValues, acknowledgeDuplicates = false) {
    setBusy(true);
    setError(null);
    setDuplicates(null);
    setPending(v);
    try {
      const created = await api<{ id: string }>('/v1/locations', {
        method: 'POST',
        body: {
          tenantId: activeTenantId,
          name: v.name,
          timezone: v.timezone,
          addressLine1: v.addressLine1 || undefined,
          city: v.city || undefined,
          region: v.region || undefined,
          postalCode: v.postalCode || undefined,
          mainPhone: v.mainPhone ? normalizePhone(v.mainPhone) : undefined,
          acknowledgeDuplicates: acknowledgeDuplicates || undefined,
        },
      });
      await qc.invalidateQueries({ queryKey: ['locations', activeTenantId] });
      setActiveLocation(created.id);
      onClose();
    } catch (err) {
      const findings = duplicateFindings(err);
      if (findings) setDuplicates(findings);
      else setError(err instanceof Error ? err.message : 'Could not create location');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 py-10">
      <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Add a location</h2>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-brayz">
            Close
          </button>
        </div>
        <p className="mb-4 text-sm text-slate-500">
          A new restaurant location with its own menu, hours, settings, and phone number.
        </p>
        {duplicates && pending && (
          <div className="mb-4">
            <DuplicateWarning findings={duplicates} busy={busy} onContinue={() => onSubmit(pending, true)} />
          </div>
        )}
        <LocationForm submitLabel="Create location" busy={busy} error={error} onSubmit={(v) => onSubmit(v)} onCancel={onClose} />
      </div>
    </div>
  );
}
