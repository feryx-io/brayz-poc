'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StatCard } from '@/components/StatCard';
import { useAuth } from '@/lib/auth';
import {
  formatMoney,
  useLocations,
  useLoyaltySettings,
  useLoyaltyStats,
  usePromotions,
  type LoyaltySettings,
  type LoyaltyStats,
  type Promotion,
  type PromotionAudience,
  type PromotionKind,
} from '@/lib/queries';

/**
 * Loyalty (plan §2 "Loyalty" screen): the whole programme in one place — how it
 * is performing, the rules behind it, and the offers built on those rules.
 *
 * The rules moved here from Settings because they only mean something next to
 * what they produce, and because promotions target audiences ("VIP", "lapsed")
 * that these very rules define — a restaurant should not have to hold two
 * screens in their head to understand who an offer reaches.
 */
export default function LoyaltyPage() {
  const { api, activeLocationId, canManage } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const locationId = activeLocationId ?? locations.data?.[0]?.id;
  const settings = useLoyaltySettings(locationId);
  const stats = useLoyaltyStats(locationId);
  const promotions = usePromotions(locationId);

  if (locations.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!locationId) return <p className="text-slate-500">No location found.</p>;

  return (
    <div className="max-w-3xl space-y-10">
      <h1 className="text-2xl font-bold">Loyalty</h1>
      {!canManage && (
        <p className="rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600">
          You have view-only access. Editing requires a manager or owner role.
        </p>
      )}

      <StatsPanel stats={stats.data} loading={stats.isLoading} />

      <LoyaltySection
        initial={settings.data}
        canManage={canManage}
        onSave={async (patch) => {
          await api(`/v1/locations/${locationId}/loyalty-settings`, { method: 'PUT', body: patch });
          qc.invalidateQueries({ queryKey: ['loyalty-settings'] });
          qc.invalidateQueries({ queryKey: ['loyalty-stats'] });
        }}
      />

      <PromotionsSection
        promotions={promotions.data ?? []}
        loading={promotions.isLoading}
        canManage={canManage}
        onCreate={async (body) => {
          await api(`/v1/locations/${locationId}/promotions`, { method: 'POST', body });
          qc.invalidateQueries({ queryKey: ['promotions'] });
        }}
        onPatch={async (id, patch) => {
          await api(`/v1/promotions/${id}`, { method: 'PATCH', body: patch });
          qc.invalidateQueries({ queryKey: ['promotions'] });
        }}
        onDelete={async (id) => {
          await api(`/v1/promotions/${id}`, { method: 'DELETE' });
          qc.invalidateQueries({ queryKey: ['promotions'] });
        }}
      />
    </div>
  );
}

/** How the programme is actually doing. Zeroes are shown, not hidden. */
function StatsPanel({ stats, loading }: { stats: LoyaltyStats | undefined; loading: boolean }) {
  if (loading) return <p className="text-slate-500">Loading…</p>;
  if (!stats) return null;
  if (!stats.enabled) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
        Loyalty is switched off for this location. Turn it on below and the bot will start
        mentioning points and rewards on calls.
      </div>
    );
  }

  const cards: Array<[string, string]> = [
    ['Members', String(stats.members)],
    ['VIPs', String(stats.vipCount)],
    ['Points outstanding', stats.pointsOutstanding.toLocaleString()],
  ];
  const last30: Array<[string, string]> = [
    ['Points earned', stats.last30Days.pointsEarned.toLocaleString()],
    ['Redemptions', String(stats.last30Days.redemptions)],
    ['Discounts given', formatMoney(stats.last30Days.discountCents)],
    ['Birthday bonuses', String(stats.last30Days.birthdayBonuses)],
    ['Win-back bonuses', String(stats.last30Days.winbackBonuses)],
    ['Upsell revenue', formatMoney(stats.last30Days.upsellRevenueCents)],
  ];

  return (
    <section className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map(([label, value]) => (
          <StatCard key={label} label={label} value={value} />
        ))}
      </div>
      <div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-500">Last 30 days</h3>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {last30.map(([label, value]) => (
            <StatCard key={label} label={label} value={value} />
          ))}
        </div>
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

function LoyaltySection({
  initial,
  canManage,
  onSave,
}: {
  initial: LoyaltySettings | undefined;
  canManage: boolean;
  onSave: (patch: LoyaltySettings) => Promise<void>;
}) {
  const fallback: LoyaltySettings = {
    enabled: false,
    pointsPerDollar: 10,
    rewardPoints: 500,
    rewardCents: 500,
    vipEnabled: false,
    vipSpendCents: 50000,
    vipPointsMultiplier: 2,
    birthdayEnabled: false,
    birthdayBonusPoints: 200,
    winbackEnabled: false,
    winbackDays: 60,
    winbackBonusPoints: 200,
  };
  const [form, setForm] = useState<LoyaltySettings>(initial ?? fallback);
  useEffect(() => {
    if (initial) setForm(initial);
  }, [initial]);
  const save = useMutation({ mutationFn: () => onSave(form) });
  const setNum =
    (
      k:
        | 'pointsPerDollar'
        | 'rewardPoints'
        | 'rewardCents'
        | 'vipPointsMultiplier'
        | 'birthdayBonusPoints'
        | 'winbackDays'
        | 'winbackBonusPoints',
    ) =>
    (v: string) =>
      setForm((f) => ({ ...f, [k]: Math.max(1, Math.round(Number(v) || 0)) }));

  return (
    <Section title="Loyalty rewards">
      <div className="space-y-2 text-sm">
        <Check
          label="Enable the loyalty program for this location"
          checked={form.enabled}
          onChange={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
        />
        <label className="flex items-center gap-2">
          <span>Points per dollar spent</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={form.pointsPerDollar}
            onChange={(e) => setNum('pointsPerDollar')(e.target.value)}
            className="w-24 rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-2">
          <span>Reward costs</span>
          <input
            type="number"
            min={1}
            value={form.rewardPoints}
            onChange={(e) => setNum('rewardPoints')(e.target.value)}
            className="w-28 rounded border border-slate-300 px-2 py-1"
          />
          <span>points</span>
        </label>
        <label className="flex items-center gap-2">
          <span>Reward value</span>
          <span>$</span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={(form.rewardCents / 100).toFixed(2)}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                rewardCents: Math.max(1, Math.round(parseFloat(e.target.value || '0') * 100)),
              }))
            }
            className="w-24 rounded border border-slate-300 px-2 py-1"
          />
          <span>off an order</span>
        </label>
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
          <Check
            label="VIP rule — recognize big spenders"
            checked={form.vipEnabled}
            onChange={() => setForm((f) => ({ ...f, vipEnabled: !f.vipEnabled }))}
          />
          <label className="flex items-center gap-2">
            <span>VIP after</span>
            <span>$</span>
            <input
              type="number"
              min={1}
              value={(form.vipSpendCents / 100).toFixed(0)}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  vipSpendCents: Math.max(100, Math.round(Number(e.target.value) || 0) * 100),
                }))
              }
              className="w-28 rounded border border-slate-300 px-2 py-1"
            />
            <span>lifetime spend, earning</span>
            <input
              type="number"
              min={1}
              max={10}
              value={form.vipPointsMultiplier}
              onChange={(e) => setNum('vipPointsMultiplier')(e.target.value)}
              className="w-16 rounded border border-slate-300 px-2 py-1"
            />
            <span>× points</span>
          </label>
        </div>
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <Check
            label="Birthday offer — bonus points in their birthday month (once a year)"
            checked={form.birthdayEnabled}
            onChange={() => setForm((f) => ({ ...f, birthdayEnabled: !f.birthdayEnabled }))}
          />
          <label className="flex items-center gap-2">
            <span>Birthday bonus</span>
            <input
              type="number"
              min={1}
              value={form.birthdayBonusPoints}
              onChange={(e) => setNum('birthdayBonusPoints')(e.target.value)}
              className="w-24 rounded border border-slate-300 px-2 py-1"
            />
            <span>points</span>
          </label>
        </div>
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <Check
            label="Win-back — bonus points when a lapsed guest returns"
            checked={form.winbackEnabled}
            onChange={() => setForm((f) => ({ ...f, winbackEnabled: !f.winbackEnabled }))}
          />
          <label className="flex items-center gap-2">
            <span>After</span>
            <input
              type="number"
              min={7}
              max={365}
              value={form.winbackDays}
              onChange={(e) => setNum('winbackDays')(e.target.value)}
              className="w-20 rounded border border-slate-300 px-2 py-1"
            />
            <span>days inactive, award</span>
            <input
              type="number"
              min={1}
              value={form.winbackBonusPoints}
              onChange={(e) => setNum('winbackBonusPoints')(e.target.value)}
              className="w-24 rounded border border-slate-300 px-2 py-1"
            />
            <span>points</span>
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Callers earn points automatically on confirmed orders. When a caller has enough
          points, the AI offers the reward during order confirmation; birthday and welcome-back
          bonuses are applied automatically. Loyalty status follows the same identity rules as guest
          memory.
        </p>
      </div>
      <button
        onClick={() => save.mutate()}
        disabled={save.isPending || !canManage}
        className="mt-4 rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        {save.isPending ? 'Saving…' : 'Save loyalty settings'}
      </button>
    </Section>
  );
}

const AUDIENCE_LABELS: Record<PromotionAudience, string> = {
  all: 'Everyone',
  vip: 'VIP guests',
  lapsed: "Guests who haven't ordered lately",
  birthday: 'Guests in their birthday month',
};

/** A blank offer, ready to fill in. */
function emptyDraft(): PromotionDraft {
  return {
    name: '',
    code: '',
    description: '',
    kind: 'amount_off',
    amountOffDollars: '5',
    percentOff: '10',
    minSubtotalDollars: '',
    audience: 'all',
    maxPerGuest: '1',
    maxRedemptions: '',
    endsAt: '',
  };
}

interface PromotionDraft {
  name: string;
  code: string;
  description: string;
  kind: PromotionKind;
  amountOffDollars: string;
  percentOff: string;
  minSubtotalDollars: string;
  audience: PromotionAudience;
  maxPerGuest: string;
  maxRedemptions: string;
  endsAt: string;
}

/** Dollars in the form, cents on the wire — money never travels as a float. */
function toCents(dollars: string): number | undefined {
  const n = Number(dollars);
  if (!dollars.trim() || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 100);
}

function draftToBody(draft: PromotionDraft): Record<string, unknown> {
  return {
    name: draft.name.trim(),
    code: draft.code.trim() || undefined,
    description: draft.description.trim() || undefined,
    kind: draft.kind,
    percentOff: draft.kind === 'percent_off' ? Number(draft.percentOff) : undefined,
    amountOffCents: draft.kind === 'amount_off' ? toCents(draft.amountOffDollars) : undefined,
    minSubtotalCents: toCents(draft.minSubtotalDollars) ?? 0,
    audience: draft.audience,
    maxPerGuest: Number(draft.maxPerGuest) || 1,
    maxRedemptions: draft.maxRedemptions.trim() ? Number(draft.maxRedemptions) : null,
    // A date input gives a day; an offer runs to the end of it.
    endsAt: draft.endsAt ? new Date(`${draft.endsAt}T23:59:59`).toISOString() : null,
  };
}

function PromotionsSection({
  promotions,
  loading,
  canManage,
  onCreate,
  onPatch,
  onDelete,
}: {
  promotions: Promotion[];
  loading: boolean;
  canManage: boolean;
  onCreate: (body: Record<string, unknown>) => Promise<void>;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<PromotionDraft | null>(null);
  const create = useMutation({
    mutationFn: (d: PromotionDraft) => onCreate(draftToBody(d)),
    onSuccess: () => setDraft(null),
  });

  return (
    <Section title="Promotions">
      <p className="mb-4 text-sm text-slate-500">
        Offers the AI can mention on a call and apply to an order. Brayz decides who qualifies and
        what each is worth — the bot only relays it, so an offer can never be talked up into
        something it isn’t.
      </p>

      {loading && <p className="text-sm text-slate-500">Loading…</p>}

      {!loading && promotions.length === 0 && !draft && (
        <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-400">
          No offers yet.
        </div>
      )}

      {promotions.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {promotions.map((p) => (
            <PromotionRow
              key={p.id}
              promotion={p}
              canManage={canManage}
              onPatch={onPatch}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}

      {canManage &&
        (draft ? (
          <div className="mt-4 rounded-lg border border-slate-200 p-4">
            <PromotionForm draft={draft} onChange={setDraft} />
            {create.isError && (
              <p className="mt-2 text-sm text-red-600">
                {(create.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
              </p>
            )}
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => create.mutate(draft)}
                disabled={create.isPending || !draft.name.trim()}
                className="rounded-lg bg-brayz px-4 py-2 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
              >
                {create.isPending ? 'Creating…' : 'Create offer'}
              </button>
              <button
                onClick={() => setDraft(null)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setDraft(emptyDraft())}
            className="mt-4 rounded-lg border border-slate-300 px-4 py-2 text-sm hover:bg-slate-50"
          >
            New offer
          </button>
        ))}
    </Section>
  );
}

function PromotionRow({
  promotion: p,
  canManage,
  onPatch,
  onDelete,
}: {
  promotion: Promotion;
  canManage: boolean;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const toggle = useMutation({ mutationFn: () => onPatch(p.id, { active: !p.active }) });
  const remove = useMutation({
    mutationFn: () => onDelete(p.id),
    onSuccess: () => setConfirming(false),
  });

  const expired = p.endsAt ? new Date(p.endsAt) < new Date() : false;
  const spent = p.maxRedemptions !== null && p.redemptionCount >= p.maxRedemptions;

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{p.name}</span>
          <span className="ml-2 text-sm text-slate-500">{p.offer}</span>
          {p.code && (
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
              {p.code}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {/* Say why an offer isn't running, rather than just that it isn't. */}
          {!p.active && <span className="text-slate-400">off</span>}
          {p.active && expired && <span className="text-amber-600">ended</span>}
          {p.active && !expired && spent && <span className="text-amber-600">fully redeemed</span>}
          {p.active && !expired && !spent && <span className="text-green-600">running</span>}
          {canManage && (
            <button
              onClick={() => toggle.mutate()}
              disabled={toggle.isPending}
              className="text-slate-500 hover:text-slate-700 disabled:opacity-50"
            >
              {p.active ? 'Switch off' : 'Switch on'}
            </button>
          )}
        </div>
      </div>

      <p className="mt-0.5 text-xs text-slate-500">
        {AUDIENCE_LABELS[p.audience]}
        {p.minSubtotalCents > 0 && ` · orders over ${formatMoney(p.minSubtotalCents)}`}
        {` · ${p.maxPerGuest} per guest`}
        {p.maxRedemptions !== null && ` · ${p.redemptionCount}/${p.maxRedemptions} used`}
        {p.maxRedemptions === null && p.redemptionCount > 0 && ` · ${p.redemptionCount} used`}
        {p.endsAt && ` · ends ${new Date(p.endsAt).toLocaleDateString()}`}
      </p>
      {p.description && <p className="mt-0.5 text-xs text-slate-400">{p.description}</p>}

      {remove.isError && (
        <p className="mt-1 text-xs text-red-600">
          {(remove.error as Error).message.replace(/^API \d+ [^:]+: /, '')}
        </p>
      )}

      {canManage && (
        <div className="mt-1">
          {confirming ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-slate-600">Delete this offer?</span>
              <button
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
                className="text-red-600 hover:text-red-700 disabled:opacity-50"
              >
                Yes, delete
              </button>
              <button
                onClick={() => setConfirming(false)}
                className="text-slate-500 hover:text-slate-700"
              >
                Keep it
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="text-xs text-slate-400 hover:text-red-600"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function PromotionForm({
  draft,
  onChange,
}: {
  draft: PromotionDraft;
  onChange: (d: PromotionDraft) => void;
}) {
  const set = <K extends keyof PromotionDraft>(k: K, v: PromotionDraft[K]) =>
    onChange({ ...draft, [k]: v });

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="font-medium">Name</span>
        <input
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="$5 off your order"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-medium">Discount</span>
          <select
            value={draft.kind}
            onChange={(e) => set('kind', e.target.value as PromotionKind)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="amount_off">Amount off</option>
            <option value="percent_off">Percent off</option>
          </select>
        </label>
        {draft.kind === 'amount_off' ? (
          <label className="block">
            <span className="font-medium">Dollars off</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={draft.amountOffDollars}
              onChange={(e) => set('amountOffDollars', e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        ) : (
          <label className="block">
            <span className="font-medium">Percent off</span>
            <input
              type="number"
              min={1}
              max={100}
              value={draft.percentOff}
              onChange={(e) => set('percentOff', e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
        )}
      </div>

      <label className="block">
        <span className="font-medium">Who it’s for</span>
        <select
          value={draft.audience}
          onChange={(e) => set('audience', e.target.value as PromotionAudience)}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        >
          {(Object.keys(AUDIENCE_LABELS) as PromotionAudience[]).map((a) => (
            <option key={a} value={a}>
              {AUDIENCE_LABELS[a]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-slate-500">
          VIP and lapsed use the rules set above, so there is one definition of each.
        </span>
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-medium">Minimum order (optional)</span>
          <input
            type="number"
            min={0}
            step={0.01}
            value={draft.minSubtotalDollars}
            onChange={(e) => set('minSubtotalDollars', e.target.value)}
            placeholder="No minimum"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="font-medium">Ends (optional)</span>
          <input
            type="date"
            value={draft.endsAt}
            onChange={(e) => set('endsAt', e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="font-medium">Per guest</span>
          <input
            type="number"
            min={1}
            value={draft.maxPerGuest}
            onChange={(e) => set('maxPerGuest', e.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="block">
          <span className="font-medium">Total limit (optional)</span>
          <input
            type="number"
            min={1}
            value={draft.maxRedemptions}
            onChange={(e) => set('maxRedemptions', e.target.value)}
            placeholder="Unlimited"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <label className="block">
        <span className="font-medium">Code (optional)</span>
        <input
          value={draft.code}
          onChange={(e) => set('code', e.target.value)}
          placeholder="FIVE-OFF"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <span className="mt-1 block text-xs text-slate-500">
          Callers say this out loud, so keep it short and easy to hear. Leave it blank for an offer
          the bot simply mentions when a guest qualifies.
        </span>
      </label>

      <label className="block">
        <span className="font-medium">How the bot describes it (optional)</span>
        <input
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Five dollars off any order this week."
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
    </div>
  );
}
