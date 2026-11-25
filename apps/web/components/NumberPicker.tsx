'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import type { AvailableNumber } from '@/lib/queries';

/**
 * Search the carrier for available Brayz numbers near the restaurant and
 * provision one to a location. Reused by the setup wizard and Settings.
 */
export function NumberPicker({
  locationId,
  defaultAreaCode,
  defaultRegion,
  onProvisioned,
}: {
  locationId: string;
  defaultAreaCode?: string;
  defaultRegion?: string;
  onProvisioned?: (e164Number: string) => void;
}) {
  const { api, activeTenantId } = useAuth();
  const qc = useQueryClient();
  const [areaCode, setAreaCode] = useState(defaultAreaCode ?? '');
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [provisioning, setProvisioning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSearching(true);
    setResults(null);
    try {
      const params = new URLSearchParams();
      if (areaCode.trim()) params.set('areaCode', areaCode.trim());
      else if (defaultRegion) params.set('region', defaultRegion);
      const res = await api<{ numbers: AvailableNumber[] }>(`/v1/numbers/available?${params.toString()}`);
      setResults(res.numbers);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setSearching(false);
    }
  }

  async function onSelect(num: AvailableNumber) {
    setError(null);
    setProvisioning(num.e164Number);
    try {
      await api(`/v1/locations/${locationId}/phone-numbers/provision`, {
        method: 'POST',
        body: { e164Number: num.e164Number },
      });
      await qc.invalidateQueries({ queryKey: ['phone-numbers', activeTenantId, locationId] });
      onProvisioned?.(num.e164Number);
      setResults(null);
    } catch (err) {
      setError(friendly(err));
    } finally {
      setProvisioning(null);
    }
  }

  return (
    <div>
      <form className="flex items-end gap-2" onSubmit={onSearch}>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Area code</span>
          <input
            value={areaCode}
            onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
            placeholder="518"
            inputMode="numeric"
            className="mt-1 w-24 rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={searching}
          className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          {searching ? 'Searching…' : 'Search numbers'}
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      {results && results.length === 0 && (
        <p className="mt-3 text-sm text-slate-500">No numbers found — try a different area code.</p>
      )}

      {results && results.length > 0 && (
        <ul className="mt-4 divide-y divide-slate-100 rounded-lg border border-slate-200">
          {results.map((n) => (
            <li key={n.e164Number} className="flex items-center justify-between px-4 py-2.5">
              <span className="text-sm">
                <span className="font-medium">{n.friendlyName || n.e164Number}</span>
                {(n.locality || n.region) && (
                  <span className="ml-2 text-slate-500">
                    {[n.locality, n.region].filter(Boolean).join(', ')}
                  </span>
                )}
              </span>
              <button
                onClick={() => onSelect(n)}
                disabled={!!provisioning}
                className="rounded-lg border border-brayz px-3 py-1 text-sm font-medium text-brayz hover:bg-brayz/10 disabled:opacity-50"
              >
                {provisioning === n.e164Number ? 'Setting up…' : 'Use this number'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('503') || msg.includes('carrier_not_configured')) {
    return 'Phone provisioning isn’t configured yet. Ask an admin to connect Twilio.';
  }
  if (msg.includes('already_provisioned')) return 'That number is already in use.';
  return msg;
}
