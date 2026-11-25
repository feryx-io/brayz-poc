'use client';

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useStaff, type AiSettings, type Location, type StaffMember, type TtsVoice } from '@/lib/queries';

const STAFF_NAME = '{staff_name}';
const defaultGreeting = (restaurant: string, name: string) =>
  `Thanks for calling ${restaurant}, this is ${name}. How can I help you today?`;
const describeVoice = (v: TtsVoice) =>
  [v.accent && `${v.accent}${v.age ? ` ${v.age.toLowerCase()}` : ''}`, v.tags.slice(0, 3).join(', ')]
    .filter(Boolean)
    .join(' · ');

/**
 * Staff Voices (Phase 7). Consent is the centerpiece: a voice persona can only
 * be created after a recorded consent grant, revoking retires every voice
 * immediately, and the API audits every change.
 */
export default function StaffPage() {
  const { api, apiBlob, activeTenantId, activeLocationId, canManage } = useAuth();
  const qc = useQueryClient();
  const staff = useStaff(activeLocationId ?? undefined);
  const aiSettings = useQuery({
    queryKey: ['ai-settings', activeTenantId, activeLocationId],
    enabled: !!activeLocationId,
    queryFn: () => api<AiSettings>(`/v1/locations/${activeLocationId}/ai-settings`),
  });
  const voices = useQuery({
    queryKey: ['voices', activeTenantId],
    queryFn: () => api<{ provider: string | null; voices: TtsVoice[] }>('/v1/voices'),
    staleTime: 60 * 60 * 1000,
  });
  const location = useQuery({
    queryKey: ['location', activeTenantId, activeLocationId],
    enabled: !!activeLocationId,
    queryFn: () => api<Location>(`/v1/locations/${activeLocationId}`),
  });

  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const [newVoiceId, setNewVoiceId] = useState('');

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['staff'] });
    qc.invalidateQueries({ queryKey: ['ai-settings'] });
  };

  const addStaff = useMutation({
    mutationFn: () =>
      api(`/v1/locations/${activeLocationId}/staff`, {
        method: 'POST',
        body: { name: newName.trim(), role: newRole.trim() || undefined, providerVoiceId: newVoiceId || undefined },
      }),
    onSuccess: () => {
      setNewName('');
      setNewRole('');
      setNewVoiceId('');
      invalidate();
    },
  });
  const previewVoice = async (voiceId: string, staffName: string) => {
    const line = (location.data?.aiGreetings?.[0]?.trim() || defaultGreeting(location.data?.name ?? 'us', STAFF_NAME))
      .split(STAFF_NAME)
      .join(staffName || 'Brayz');
    const { blob } = await apiBlob(`/v1/locations/${activeLocationId}/voices/preview`, {
      method: 'POST',
      body: { voiceId, text: line },
    });
    await new Audio(URL.createObjectURL(blob)).play();
  };
  const catalog = voices.data?.voices ?? [];

  const setVoiceMode = useMutation({
    mutationFn: (body: {
      voiceMode?: string;
      fixedVoiceProfileId?: string | null;
      voiceRotation?: 'daily' | 'per_call';
      personaSwitchEnabled?: boolean;
    }) =>
      api(`/v1/locations/${activeLocationId}/ai-settings`, { method: 'PUT', body }),
    onSuccess: invalidate,
  });

  if (!activeLocationId) return <p className="text-slate-500">No location selected.</p>;
  if (staff.isLoading) return <p className="text-slate-500">Loading…</p>;

  const readyVoices = (staff.data ?? []).flatMap((s) =>
    s.voiceProfiles.filter((v) => v.status === 'ready').map((v) => ({ ...v, staffName: s.name })),
  );
  const voiceMode = aiSettings.data?.voiceMode ?? 'default';

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="text-2xl font-bold">Staff Voices</h1>
      <p className="text-sm text-slate-500">
        Build the staff who answer the phone. Each one is a persona with a name and a voice: a voice from the
        catalog, or a real person&apos;s cloned voice. Cloning requires that person&apos;s explicit, recorded
        consent — and they can revoke it at any time, which retires their cloned voice immediately. Catalog
        voices need no consent.
      </p>

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <h2 className="mb-3 font-semibold">Which voice answers calls</h2>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <select
            value={voiceMode}
            disabled={!canManage || setVoiceMode.isPending}
            onChange={(e) =>
              setVoiceMode.mutate({
                voiceMode: e.target.value,
                fixedVoiceProfileId:
                  e.target.value === 'fixed'
                    ? (aiSettings.data?.fixedVoiceProfileId ?? readyVoices[0]?.id ?? null)
                    : null,
              })
            }
            className="rounded border border-slate-300 px-2 py-1"
          >
            <option value="default">Default AI voice</option>
            <option value="fixed">One staff voice</option>
            <option value="rotate">Rotate staff voices</option>
          </select>
          {voiceMode === 'fixed' && (
            <select
              value={aiSettings.data?.fixedVoiceProfileId ?? ''}
              disabled={!canManage || setVoiceMode.isPending}
              onChange={(e) =>
                setVoiceMode.mutate({ voiceMode: 'fixed', fixedVoiceProfileId: e.target.value || null })
              }
              className="rounded border border-slate-300 px-2 py-1"
            >
              <option value="">Choose a voice…</option>
              {readyVoices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.staffName} — {v.label}
                </option>
              ))}
            </select>
          )}
          {voiceMode === 'rotate' && (
            <>
              <select
                value={aiSettings.data?.voiceRotation ?? 'daily'}
                disabled={!canManage || setVoiceMode.isPending}
                onChange={(e) =>
                  setVoiceMode.mutate({ voiceMode: 'rotate', voiceRotation: e.target.value as 'daily' | 'per_call' })
                }
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="daily">a new voice each day</option>
                <option value="per_call">a new voice each call (round robin)</option>
              </select>
              <span className="text-xs text-slate-500">Through the voices marked “in rotation” below.</span>
            </>
          )}
        </div>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={aiSettings.data?.personaSwitchEnabled ?? false}
            disabled={!canManage || setVoiceMode.isPending}
            onChange={(e) => setVoiceMode.mutate({ personaSwitchEnabled: e.target.checked })}
          />
          <span>
            Callers can ask for a staff member by name
            <span className="block text-xs text-slate-500">
              &quot;Can I talk to Jose?&quot; hands the call to Jose&apos;s voice, and the assistant carries on as Jose.
              A real transfer option for that person always wins. Off by default: a persona in an employee&apos;s
              cloned voice answering as them is a deliberate choice, and their consent should cover it. Asked
              whether it is a real person, the assistant always says it is the restaurant&apos;s AI.
            </span>
          </span>
        </label>
      </section>

      {aiSettings.data && (
        <DefaultVoiceCard
          settings={aiSettings.data}
          voices={voices.data?.voices ?? []}
          catalogLoading={voices.isLoading}
          greeting={location.data?.aiGreetings?.[0] ?? null}
          restaurant={location.data?.name ?? 'us'}
          canManage={canManage}
          onSave={async (body) => {
            await api(`/v1/locations/${activeLocationId}/ai-settings`, { method: 'PUT', body });
            invalidate();
          }}
          onPreview={async (voiceId, text) => {
            const { blob } = await apiBlob(`/v1/locations/${activeLocationId}/voices/preview`, {
              method: 'POST',
              body: { voiceId, text },
            });
            return blob;
          }}
        />
      )}

      {canManage && (
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="mb-1 font-semibold">Add staff member</h2>
          <p className="mb-3 text-xs text-slate-500">
            Pick a catalog voice now, or leave it for later and clone their real voice once consent is recorded.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <input
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              placeholder="Role (optional)"
              className="rounded border border-slate-300 px-3 py-2 text-sm"
            />
            <select
              value={newVoiceId}
              onChange={(e) => setNewVoiceId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-2 text-sm"
            >
              <option value="">Voice: decide later / clone a real voice</option>
              {catalog.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {describeVoice(v)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => previewVoice(newVoiceId, newName.trim())}
              disabled={!newVoiceId}
              title={newVoiceId ? 'Hear this voice say your greeting' : 'Pick a catalog voice to preview'}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              ▶
            </button>
            <button
              onClick={() => addStaff.mutate()}
              disabled={!newName.trim() || addStaff.isPending}
              className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {addStaff.isError && (
            <p className="mt-2 text-sm text-red-600">{(addStaff.error as Error).message}</p>
          )}
        </section>
      )}

      {(staff.data ?? []).length === 0 ? (
        <p className="text-sm text-slate-400">No staff members yet.</p>
      ) : (
        (staff.data ?? []).map((s) => (
          <StaffCard
            key={s.id}
            staff={s}
            catalog={catalog}
            canManage={canManage}
            onChanged={invalidate}
            onPreview={(voiceId) => previewVoice(voiceId, s.name)}
          />
        ))
      )}
    </div>
  );
}

function StaffCard({
  staff,
  catalog,
  canManage,
  onChanged,
  onPreview,
}: {
  staff: StaffMember;
  catalog: TtsVoice[];
  canManage: boolean;
  onChanged: () => void;
  onPreview: (voiceId: string) => Promise<void>;
}) {
  const { api } = useAuth();
  const [voiceLabel, setVoiceLabel] = useState('');
  const [consentSource, setConsentSource] = useState('dashboard');
  const currentCatalog = staff.voiceProfiles.find((v) => v.source === 'provider' && v.providerVoiceId);
  const [catalogVoiceId, setCatalogVoiceId] = useState(currentCatalog?.providerVoiceId ?? '');
  useEffect(() => setCatalogVoiceId(currentCatalog?.providerVoiceId ?? ''), [currentCatalog?.providerVoiceId]);
  const assignCatalogVoice = useMutation({
    mutationFn: () =>
      api(`/v1/staff/${staff.id}/voice/provider`, { method: 'POST', body: { voiceId: catalogVoiceId } }),
    onSuccess: () => {
      setCatalogVoiceId('');
      onChanged();
    },
  });

  const consent = useMutation({
    mutationFn: (action: 'granted' | 'revoked') =>
      api(`/v1/staff/${staff.id}/consent`, {
        method: 'POST',
        body: { action, source: consentSource },
      }),
    onSuccess: onChanged,
  });
  const addVoice = useMutation({
    mutationFn: () =>
      api(`/v1/staff/${staff.id}/voice`, { method: 'POST', body: { label: voiceLabel.trim() } }),
    onSuccess: () => {
      setVoiceLabel('');
      onChanged();
    },
  });
  const toggleRotation = useMutation({
    mutationFn: (v: { id: string; enabledForRotation: boolean }) =>
      api(`/v1/voice-profiles/${v.id}`, {
        method: 'PATCH',
        body: { enabledForRotation: v.enabledForRotation },
      }),
    onSuccess: onChanged,
  });
  const deleteVoice = useMutation({
    mutationFn: (id: string) => api(`/v1/voice-profiles/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  const deleteStaff = useMutation({
    mutationFn: () => api(`/v1/staff/${staff.id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  const consented = staff.consent?.action === 'granted';

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">
            {staff.name}
            {staff.role && <span className="ml-2 text-sm font-normal text-slate-500">{staff.role}</span>}
          </h3>
          <p className="mt-1 text-xs">
            {consented ? (
              <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700">
                Consent granted · {staff.consent!.source} · {new Date(staff.consent!.at).toLocaleDateString()}
              </span>
            ) : staff.consent ? (
              <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-700">
                Consent revoked · {new Date(staff.consent.at).toLocaleDateString()}
              </span>
            ) : (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600">
                No consent on record
              </span>
            )}
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => deleteStaff.mutate()}
            className="text-sm text-red-500 hover:text-red-700"
          >
            Remove
          </button>
        )}
      </div>

      {canManage && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          {!consented ? (
            <>
              <select
                value={consentSource}
                onChange={(e) => setConsentSource(e.target.value)}
                className="rounded border border-slate-300 px-2 py-1"
              >
                <option value="dashboard">Consented via dashboard (covers answering calls as them)</option>
                <option value="paper">Signed paper form</option>
                <option value="recorded_call">Recorded verbal consent</option>
              </select>
              <button
                onClick={() => consent.mutate('granted')}
                disabled={consent.isPending}
                className="rounded-lg bg-brayz px-3 py-1.5 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
              >
                Record consent
              </button>
            </>
          ) : (
            <button
              onClick={() => consent.mutate('revoked')}
              disabled={consent.isPending}
              className="rounded-lg border border-red-300 px-3 py-1.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              Revoke consent (retires their cloned voices)
            </button>
          )}
        </div>
      )}

      <div className="mt-4 space-y-2">
        {staff.voiceProfiles.length === 0 && (
          <p className="text-sm text-slate-400">No voice personas yet.</p>
        )}
        {staff.voiceProfiles.map((v) => (
          <div key={v.id} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{v.label}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
              {v.source === 'provider' ? 'catalog voice' : 'cloned voice'}
            </span>
            {v.source === 'provider' &&
              v.providerVoiceId &&
              (() => {
                // The label defaults to the voice's name; only say it again when the owner relabelled.
                const name = catalog.find((cv) => cv.id === v.providerVoiceId)?.name ?? v.providerVoiceId;
                return name !== v.label ? <span className="text-xs text-slate-500">{name}</span> : null;
              })()}
            {v.source === 'provider' && v.providerVoiceId && (
              <button
                type="button"
                onClick={() => onPreview(v.providerVoiceId!)}
                className="text-xs text-slate-600 hover:text-brayz"
                title="Hear this voice say your greeting"
              >
                ▶ preview
              </button>
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                v.status === 'ready'
                  ? 'bg-green-100 text-green-700'
                  : v.status === 'revoked'
                    ? 'bg-red-100 text-red-700'
                    : 'bg-slate-100 text-slate-600'
              }`}
            >
              {v.status}
            </span>
            {canManage && v.status === 'ready' && (
              <label className="flex items-center gap-1 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={v.enabledForRotation}
                  onChange={(e) =>
                    toggleRotation.mutate({ id: v.id, enabledForRotation: e.target.checked })
                  }
                />
                in rotation
              </label>
            )}
            {canManage && (
              <button
                onClick={() => deleteVoice.mutate(v.id)}
                className="text-xs text-red-500 hover:text-red-700"
              >
                delete
              </button>
            )}
          </div>
        ))}
        {canManage && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <select
              value={catalogVoiceId}
              onChange={(e) => setCatalogVoiceId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5"
            >
              <option value="">{currentCatalog ? 'Change catalog voice…' : 'Assign a catalog voice…'}</option>
              {catalog.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {describeVoice(v)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onPreview(catalogVoiceId)}
              disabled={!catalogVoiceId}
              className="rounded-lg border border-slate-300 px-2 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-50"
              title="Hear it first"
            >
              ▶
            </button>
            <button
              type="button"
              onClick={() => assignCatalogVoice.mutate()}
              disabled={!catalogVoiceId || catalogVoiceId === currentCatalog?.providerVoiceId || assignCatalogVoice.isPending}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              {currentCatalog ? 'Change voice' : 'Use this voice'}
            </button>
          </div>
        )}
        {canManage && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <input
              value={voiceLabel}
              onChange={(e) => setVoiceLabel(e.target.value)}
              placeholder='Clone label (e.g. "Front desk")'
              disabled={!consented}
              className="rounded border border-slate-300 px-3 py-1.5 disabled:bg-slate-50"
            />
            <button
              onClick={() => addVoice.mutate()}
              disabled={!consented || !voiceLabel.trim() || addVoice.isPending}
              title={consented ? undefined : 'Record consent first'}
              className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium hover:bg-slate-50 disabled:opacity-50"
            >
              Clone their real voice
            </button>
            {!consented && (
              <span className="text-xs text-slate-400">Cloning requires recorded consent.</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The built-in voice: which of the provider's voices answers when no staff
 * voice does, and the name it introduces itself with. Preview speaks the
 * location's own greeting (with {staff_name} filled in) so what the owner
 * hears is what a caller will.
 */
function DefaultVoiceCard({
  settings,
  voices,
  catalogLoading,
  greeting,
  restaurant,
  canManage,
  onSave,
  onPreview,
}: {
  settings: AiSettings;
  voices: TtsVoice[];
  catalogLoading: boolean;
  greeting: string | null;
  restaurant: string;
  canManage: boolean;
  onSave: (body: { defaultVoiceId: string | null; assistantName: string | null }) => Promise<void>;
  onPreview: (voiceId: string, text: string) => Promise<Blob>;
}) {
  const [voiceId, setVoiceId] = useState(settings.defaultVoiceId ?? '');
  const [name, setName] = useState(settings.assistantName ?? '');
  useEffect(() => {
    setVoiceId(settings.defaultVoiceId ?? '');
    setName(settings.assistantName ?? '');
  }, [settings.defaultVoiceId, settings.assistantName]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const spokenName = name.trim() || 'Brayz';
  const line = (greeting?.trim() ? greeting : defaultGreeting(restaurant, STAFF_NAME))
    .split(STAFF_NAME)
    .join(spokenName);

  const save = useMutation({
    mutationFn: () => onSave({ defaultVoiceId: voiceId || null, assistantName: name.trim() || null }),
  });
  const preview = useMutation({
    mutationFn: async () => {
      const blob = await onPreview(voiceId, line);
      audioRef.current?.pause();
      const audio = new Audio(URL.createObjectURL(blob));
      audioRef.current = audio;
      await audio.play();
    },
  });
  useEffect(() => () => audioRef.current?.pause(), []);

  const dirty = (voiceId || null) !== (settings.defaultVoiceId ?? null) || (name.trim() || null) !== (settings.assistantName ?? null);
  const selected = voices.find((v) => v.id === voiceId);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6">
      <h2 className="mb-1 font-semibold">Default AI voice</h2>
      <p className="mb-3 text-sm text-slate-500">
        The voice that answers when no staff voice does, and the name it goes by. Put{' '}
        <code className="rounded bg-slate-100 px-1">{STAFF_NAME}</code> in your greeting and it becomes this name — or
        the staff member&apos;s, when their voice answers.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="font-medium">Voice</span>
          <select
            value={voiceId}
            disabled={!canManage || catalogLoading}
            onChange={(e) => setVoiceId(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          >
            <option value="">Provider default</option>
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} — {describeVoice(v)}
              </option>
            ))}
          </select>
          {!catalogLoading && voices.length === 0 && (
            <span className="mt-1 block text-xs text-slate-500">No voice catalog — the speech provider is not configured.</span>
          )}
        </label>
        <label className="block text-sm">
          <span className="font-medium">Name</span>
          <input
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            placeholder="Sam"
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Preview says: <span className="italic text-slate-700">“{line}”</span>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => preview.mutate()}
          disabled={!canManage || !voiceId || preview.isPending}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
          title={voiceId ? `Hear ${selected?.name ?? 'this voice'}` : 'Pick a voice to preview'}
        >
          {preview.isPending ? 'Speaking…' : '▶ Preview'}
        </button>
        <button
          type="button"
          onClick={() => save.mutate()}
          disabled={!canManage || !dirty || save.isPending}
          className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
        >
          {save.isPending ? 'Saving…' : 'Save voice'}
        </button>
        {save.isSuccess && !dirty && <span className="text-sm text-emerald-700">Saved.</span>}
        {(preview.isError || save.isError) && (
          <span className="text-sm text-red-600">
            {((preview.error ?? save.error) as Error).message.replace(/^API \d+ [^:]+: /, '')}
          </span>
        )}
      </div>
    </section>
  );
}
