'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import {
  formatMoney,
  parseMoney,
  useLocations,
  useMenu,
  useMenuGaps,
  useMenuHealth,
  type MenuGap,
  type MenuHealthFinding,
  type MenuHealthFix,
  type MenuItem,
  type Modifier,
  type ModifierGroup,
} from '@/lib/queries';
import { MenuImport } from '@/components/MenuImport';
import { MenuTemplates } from '@/components/MenuTemplates';
import { applyMenuFix } from '@/lib/menuFix';
import { findingToQuestion, stashAssistantQuestion } from '@/lib/assistantHandoff';

export default function MenuPage() {
  const { api, activeTenantId, activeLocationId, canManage } = useAuth();
  const qc = useQueryClient();
  const locations = useLocations();
  const [importing, setImporting] = useState(false);
  const [templating, setTemplating] = useState(false);
  const activeLocation = activeLocationId ?? locations.data?.[0]?.id;
  const menu = useMenu(activeLocation);
  const gaps = useMenuGaps(activeLocation);
  const health = useMenuHealth(activeLocation);

  const menuLoaded = menu.isSuccess || menu.isError;
  const hasItems = (menu.data?.categories ?? []).some((c) => c.items.length > 0);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['menu', activeTenantId, activeLocation] });
    qc.invalidateQueries({ queryKey: ['menu-health', activeTenantId, activeLocation] });
  };

  // A fix is the same edit the editor makes, through the same routes — so it
  // carries the same role check and audit entry as a hand edit.
  const applyFix = useMutation({
    mutationFn: (fix: MenuHealthFix) => applyMenuFix(api, fix, activeLocation!),
    onSuccess: invalidate,
  });

  const addCategory = useMutation({
    mutationFn: (name: string) =>
      api(`/v1/locations/${activeLocation}/menu/categories`, { method: 'POST', body: { name } }),
    onSuccess: invalidate,
  });
  const addItem = useMutation({
    mutationFn: (v: { categoryId: string; name: string; priceCents: number }) =>
      api(`/v1/locations/${activeLocation}/menu/items`, { method: 'POST', body: v }),
    onSuccess: invalidate,
  });
  const deleteItem = useMutation({
    mutationFn: (itemId: string) => api(`/v1/menu/items/${itemId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });
  const renameCategory = useMutation({
    mutationFn: (v: { id: string; name: string }) =>
      api(`/v1/menu/categories/${v.id}`, { method: 'PATCH', body: { name: v.name } }),
    onSuccess: invalidate,
  });
  const deleteCategory = useMutation({
    mutationFn: (id: string) => api(`/v1/menu/categories/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  });

  if (locations.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (!activeLocation) return <p className="text-slate-500">Create a location first (Settings).</p>;

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Menu</h1>
      </div>

      {!canManage && (
        <p className="mb-4 rounded-lg bg-slate-100 px-4 py-2 text-sm text-slate-600">
          View-only access — editing requires a manager or owner role.
        </p>
      )}

      {canManage && !importing && !templating && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <AddCategory onAdd={(name) => addCategory.mutate(name)} busy={addCategory.isPending} />
            {hasItems && (
              <button
                onClick={() => setTemplating(true)}
                className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-brayz hover:text-brayz"
                title="Give items with no choices the toppings, sauces and bread options a phone order needs"
              >
                Add option groups
              </button>
            )}
            <button
              onClick={() => setImporting(true)}
              className="shrink-0 rounded-lg border border-brayz px-4 py-2 text-sm font-medium text-brayz hover:bg-brayz/10"
            >
              Import menu
            </button>
          </div>
        </div>
      )}

      {canManage && activeLocation && (templating || (menuLoaded && !hasItems && !importing)) && (
        <div className="mt-4">
          <MenuTemplates
            locationId={activeLocation}
            hasItems={hasItems}
            onApplied={invalidate}
            onClose={templating ? () => setTemplating(false) : undefined}
          />
        </div>
      )}

      {health.data && activeLocation && (
        <MenuHealthCard
          locationId={activeLocation}
          findings={health.data.findings}
          days={health.data.days}
          canManage={canManage}
          applying={applyFix.isPending}
          onApply={(fix) => applyFix.mutate(fix)}
          error={applyFix.isError ? (applyFix.error as Error).message : null}
        />
      )}

      {(gaps.data?.length ?? 0) > 0 && <MenuGapsCard gaps={gaps.data ?? []} />}

      {canManage && importing && activeLocation && (
        <MenuImport
          locationId={activeLocation}
          onClose={() => setImporting(false)}
          onImported={invalidate}
        />
      )}

      <div className="mt-8 space-y-6">
        {menu.data?.categories.length === 0 && (
          <p className="text-sm text-slate-500">No categories yet.</p>
        )}
        {menu.data?.categories.map((cat) => (
          <section key={cat.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <CategoryHeader
              id={cat.id}
              name={cat.name}
              itemCount={cat.items.length}
              canManage={canManage}
              onRename={(name) => renameCategory.mutate({ id: cat.id, name })}
              onDelete={() => deleteCategory.mutate(cat.id)}
            />
            <ul className="mt-3 divide-y divide-slate-100">
              {cat.items.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  canManage={canManage}
                  onDelete={() => deleteItem.mutate(item.id)}
                  onChanged={invalidate}
                />
              ))}
              {cat.items.length === 0 && <li className="py-2 text-sm text-slate-400">No items</li>}
            </ul>
            {canManage && (
              <AddItem
                onAdd={(name, price) =>
                  addItem.mutate({ categoryId: cat.id, name, priceCents: parseMoney(price) })
                }
                busy={addItem.isPending}
              />
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

const SEVERITY: Record<MenuHealthFinding['severity'], { label: string; tone: string }> = {
  fix: { label: 'Fix', tone: 'bg-red-100 text-red-700' },
  warn: { label: 'Check', tone: 'bg-amber-100 text-amber-700' },
  info: { label: 'Note', tone: 'bg-slate-100 text-slate-600' },
};

/**
 * What about the menu will trip the bot up, from the menu and from what
 * callers asked for, each with the edit that fixes it where one is a plain
 * menu edit. Dismissals are per browser: a finding the owner has decided is
 * fine should not nag, but it should come back on another machine, since it
 * is still true.
 */
function MenuHealthCard({
  locationId,
  findings,
  days,
  canManage,
  applying,
  onApply,
  error,
}: {
  locationId: string;
  findings: MenuHealthFinding[];
  days: number;
  canManage: boolean;
  applying: boolean;
  onApply: (fix: MenuHealthFix) => void;
  error: string | null;
}) {
  const storageKey = `brayz.menuHealth.dismissed.${locationId}`;
  const router = useRouter();
  const [dismissed, setDismissed] = useState<string[]>([]);
  // A finding with no ready-made fix (or one the owner is unsure about) goes
  // to the assistant as a question, with the same facts the card shows.
  const discuss = (f: MenuHealthFinding) => {
    stashAssistantQuestion(locationId, findingToQuestion(f));
    router.push('/app/assistant');
  };
  useEffect(() => {
    try {
      setDismissed(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));
    } catch {
      setDismissed([]);
    }
  }, [storageKey]);
  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* fine without */
    }
  };
  const [showDismissed, setShowDismissed] = useState(false);

  const visible = findings.filter((f) => showDismissed || !dismissed.includes(f.id));
  const hidden = findings.length - findings.filter((f) => !dismissed.includes(f.id)).length;

  if (findings.length === 0) {
    return (
      <div className="mt-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
        Menu health: nothing to fix. Checked the menu and the last {days} days of calls.
      </div>
    );
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="font-semibold">Menu health</h2>
        <span className="text-xs text-slate-500">
          From the menu and the last {days} days of calls
          {hidden > 0 && (
            <>
              {' · '}
              <button onClick={() => setShowDismissed((v) => !v)} className="text-brayz hover:underline">
                {showDismissed ? 'hide' : 'show'} {hidden} dismissed
              </button>
            </>
          )}
        </span>
      </div>
      {error && <p className="mb-3 text-sm text-red-600">{error.replace(/^API \d+ [^:]+: /, '')}</p>}
      <ul className="divide-y divide-slate-100">
        {visible.map((f) => {
          const sev = SEVERITY[f.severity];
          const isDismissed = dismissed.includes(f.id);
          return (
            <li key={f.id} className={'flex items-start gap-3 py-3 ' + (isDismissed ? 'opacity-50' : '')}>
              <span className={'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ' + sev.tone}>
                {sev.label}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{f.title}</p>
                <p className="mt-0.5 text-sm text-slate-600">{f.detail}</p>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {f.fix && canManage && !isDismissed && (
                  <button
                    onClick={() => onApply(f.fix!)}
                    disabled={applying}
                    className="rounded-lg bg-brayz px-3 py-1 text-xs font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
                  >
                    {applying ? 'Applying…' : 'Apply fix'}
                  </button>
                )}
                {canManage && !isDismissed && (
                  <button
                    onClick={() => discuss(f)}
                    className={
                      f.fix
                        ? 'text-xs text-slate-500 hover:underline'
                        : 'rounded-lg border border-brayz px-3 py-1 text-xs font-medium text-brayz hover:bg-brayz hover:text-white'
                    }
                  >
                    Ask the assistant
                  </button>
                )}
                {!isDismissed && (
                  <button onClick={() => dismiss(f.id)} className="text-xs text-slate-500 hover:underline">
                    Dismiss
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ItemRow({
  item,
  canManage,
  onDelete,
  onChanged,
}: {
  item: MenuItem;
  canManage: boolean;
  onDelete: () => void;
  onChanged: () => void;
}) {
  const { api } = useAuth();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const groupCount = item.modifierGroups?.length ?? 0;

  const updateItem = useMutation({
    mutationFn: (body: { name?: string; priceCents?: number; available?: boolean; ingredients?: string[]; upsellTags?: string[] }) =>
      api(`/v1/menu/items/${item.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      onChanged();
      setEditing(false);
    },
  });

  const addGroup = useMutation({
    mutationFn: (v: {
      name: string;
      selectionType: 'single' | 'multi';
      required: boolean;
    }) => api(`/v1/menu/items/${item.id}/modifier-groups`, { method: 'POST', body: v }),
    onSuccess: onChanged,
  });
  const addModifier = useMutation({
    mutationFn: (v: { groupId: string; name: string; priceCents: number }) =>
      api(`/v1/menu/modifier-groups/${v.groupId}/modifiers`, {
        method: 'POST',
        body: { name: v.name, priceCents: v.priceCents },
      }),
    onSuccess: onChanged,
  });
  const updateGroup = useMutation({
    mutationFn: (v: { id: string; patch: Partial<ModifierGroup> }) =>
      api(`/v1/menu/modifier-groups/${v.id}`, { method: 'PATCH', body: v.patch }),
    onSuccess: onChanged,
  });
  const deleteGroup = useMutation({
    mutationFn: (id: string) => api(`/v1/menu/modifier-groups/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });
  const updateModifier = useMutation({
    mutationFn: (v: { id: string; patch: { name?: string; priceCents?: number } }) =>
      api(`/v1/menu/modifiers/${v.id}`, { method: 'PATCH', body: v.patch }),
    onSuccess: onChanged,
  });
  const deleteModifier = useMutation({
    mutationFn: (id: string) => api(`/v1/menu/modifiers/${id}`, { method: 'DELETE' }),
    onSuccess: onChanged,
  });

  return (
    <li className="py-2">
      {editing ? (
        <EditItem
          item={item}
          busy={updateItem.isPending}
          onCancel={() => setEditing(false)}
          onSave={(body) => updateItem.mutate(body)}
        />
      ) : (
        <div className="flex items-center justify-between">
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 text-left">
            <span className="text-slate-400">{open ? '▾' : '▸'}</span>
            <span>
              {item.name}
              {!item.available && <em className="ml-2 text-xs text-amber-600">unavailable</em>}
              {groupCount > 0 && (
                <span className="ml-2 text-xs text-slate-400">
                  {groupCount} modifier group{groupCount > 1 ? 's' : ''}
                </span>
              )}
              {item.upsellTags && item.upsellTags.length > 0 && (
                <span className="ml-2 text-xs text-slate-400">
                  offered with {item.upsellTags.join(', ')}
                </span>
              )}
              {item.ingredients && item.ingredients.length > 0 && (
                <span className="mt-0.5 block text-xs text-slate-400">
                  {item.ingredients.join(', ')}
                </span>
              )}
            </span>
          </button>
          <span className="flex items-center gap-3">
            <span className="tabular-nums text-slate-600">{formatMoney(item.priceCents)}</span>
            {canManage && (
              <>
                <button onClick={() => setEditing(true)} className="text-xs text-brayz hover:underline">
                  Edit
                </button>
                <button onClick={onDelete} className="text-xs text-red-500 hover:underline">
                  Delete
                </button>
              </>
            )}
          </span>
        </div>
      )}

      {open && !editing && (
        <div className="ml-6 mt-2 space-y-3 border-l border-slate-100 pl-4">
          {item.modifierGroups?.map((g) => (
            <ModifierGroupRow
              key={g.id}
              group={g}
              canManage={canManage}
              onAddModifier={(name, price) =>
                addModifier.mutate({ groupId: g.id, name, priceCents: parseMoney(price) })
              }
              onRenameGroup={(name) => updateGroup.mutate({ id: g.id, patch: { name } })}
              onToggleRequired={() =>
                updateGroup.mutate({ id: g.id, patch: { required: !g.required } })
              }
              onToggleHalves={() =>
                updateGroup.mutate({ id: g.id, patch: { allowsHalves: !g.allowsHalves } })
              }
              onHalfPricing={(halfPricing) => updateGroup.mutate({ id: g.id, patch: { halfPricing } })}
              onDeleteGroup={() => deleteGroup.mutate(g.id)}
              onEditModifier={(id, name, price) =>
                updateModifier.mutate({ id, patch: { name, priceCents: parseMoney(price) } })
              }
              onDeleteModifier={(id) => deleteModifier.mutate(id)}
            />
          ))}
          {groupCount === 0 && <p className="text-xs text-slate-400">No modifier groups.</p>}
          {canManage && <AddGroup onAdd={(v) => addGroup.mutate(v)} busy={addGroup.isPending} />}
        </div>
      )}
    </li>
  );
}

/**
 * What callers asked for that this menu does not sell.
 *
 * Every one of these is a caller told "we don't have that" — the restaurant
 * never heard about it. Shown on the menu screen rather than the dashboard
 * because the useful next move is to add the thing, and it is right here.
 */
function MenuGapsCard({ gaps }: { gaps: MenuGap[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? gaps : gaps.slice(0, 5);
  return (
    <section className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <h2 className="text-sm font-semibold text-amber-900">Asked for, not on your menu</h2>
      <p className="mt-0.5 text-xs text-amber-800">
        Requests from the last 30 days the AI had to turn down. Adding one means the next caller
        gets it — and gets charged for it — and it comes off this list.
      </p>
      <ul className="mt-3 space-y-1.5">
        {shown.map((g) => (
          <li key={g.term} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-slate-800">
              {g.label}
              {g.kind === 'option' && g.onItems.length > 0 && (
                <span className="text-xs text-slate-500"> — on {g.onItems.join(', ')}</span>
              )}
            </span>
            <span className="shrink-0 tabular-nums text-slate-600">
              {g.count} {g.count === 1 ? 'time' : 'times'}
            </span>
          </li>
        ))}
      </ul>
      {gaps.length > 5 && (
        <button
          onClick={() => setOpen((o) => !o)}
          className="mt-2 text-xs text-amber-900 hover:underline"
        >
          {open ? 'Show less' : `Show ${gaps.length - 5} more`}
        </button>
      )}
    </section>
  );
}

function ModifierGroupRow({
  group,
  canManage,
  onAddModifier,
  onRenameGroup,
  onToggleRequired,
  onToggleHalves,
  onHalfPricing,
  onDeleteGroup,
  onEditModifier,
  onDeleteModifier,
}: {
  group: ModifierGroup;
  canManage: boolean;
  onAddModifier: (name: string, price: string) => void;
  onRenameGroup: (name: string) => void;
  onToggleRequired: () => void;
  onToggleHalves: () => void;
  onHalfPricing: (halfPricing: 'full' | 'half') => void;
  onDeleteGroup: () => void;
  onEditModifier: (id: string, name: string, price: string) => void;
  onDeleteModifier: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div>
      {renaming ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onRenameGroup(name.trim());
            setRenaming(false);
          }}
          className="flex items-center gap-2 text-sm"
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded border border-slate-300 px-2 py-0.5"
            autoFocus
          />
          <button type="submit" className="text-xs text-brayz hover:underline">
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setName(group.name);
              setRenaming(false);
            }}
            className="text-xs text-slate-500 hover:underline"
          >
            Cancel
          </button>
        </form>
      ) : (
        <p className="flex items-center gap-2 text-sm font-medium">
          {group.name}{' '}
          <span className="text-xs font-normal text-slate-400">
            ({group.selectionType}
            {group.required ? ', required' : ''}
            {group.allowsHalves ? ', half-and-half' : ''})
          </span>
          {canManage && (
            <>
              <button onClick={() => setRenaming(true)} className="text-xs font-normal text-slate-500 hover:underline">
                Rename
              </button>
              <button onClick={onToggleRequired} className="text-xs font-normal text-slate-500 hover:underline">
                {group.required ? 'Make optional' : 'Make required'}
              </button>
              {group.selectionType === 'multi' && (
                // Halves only make sense where several options can be chosen:
                // a single-choice crust is one crust.
                <button onClick={onToggleHalves} className="text-xs font-normal text-slate-500 hover:underline">
                  {group.allowsHalves ? 'No half-and-half' : 'Allow half-and-half'}
                </button>
              )}
              {group.allowsHalves && (
                <label className="text-xs font-normal text-slate-500">
                  a half costs{' '}
                  <select
                    value={group.halfPricing ?? 'full'}
                    onChange={(e) => onHalfPricing(e.target.value as 'full' | 'half')}
                    className="rounded border border-slate-300 px-1 py-0.5 text-xs"
                  >
                    <option value="full">the full option price</option>
                    <option value="half">half the option price</option>
                  </select>
                </label>
              )}
              <button
                onClick={() => {
                  // Named, and counted: a group is the only thing here whose
                  // deletion silently takes other rows (its options) with it.
                  const n = group.modifiers.length;
                  if (confirm(`Delete the "${group.name}" group and its ${n} option${n === 1 ? '' : 's'}?`))
                    onDeleteGroup();
                }}
                className="text-xs font-normal text-rose-600 hover:underline"
              >
                Delete group
              </button>
            </>
          )}
        </p>
      )}
      <ul className="ml-2 mt-1 space-y-0.5 text-sm text-slate-600">
        {group.modifiers.map((m) =>
          editing === m.id ? (
            <li key={m.id}>
              <EditModifier
                modifier={m}
                onSave={(n, p) => {
                  onEditModifier(m.id, n, p);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            </li>
          ) : (
            <li key={m.id} className="flex items-center justify-between gap-2">
              <span>{m.name}</span>
              <span className="flex items-center gap-2">
                {m.priceCents > 0 && <span className="tabular-nums">+{formatMoney(m.priceCents)}</span>}
                {m.priceCents === 0 && <span className="text-xs text-slate-400">included</span>}
                {canManage && (
                  <>
                    <button onClick={() => setEditing(m.id)} className="text-xs text-slate-500 hover:underline">
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete the "${m.name}" option?`)) onDeleteModifier(m.id);
                      }}
                      className="text-xs text-rose-600 hover:underline"
                    >
                      Delete
                    </button>
                  </>
                )}
              </span>
            </li>
          ),
        )}
        {group.modifiers.length === 0 && <li className="text-xs text-slate-400">No options</li>}
      </ul>
      {canManage && <AddModifier onAdd={onAddModifier} />}
    </div>
  );
}

/** Rename an option or change its price. A $0 option is one the item includes. */
function EditModifier({
  modifier,
  onSave,
  onCancel,
}: {
  modifier: Modifier;
  onSave: (name: string, price: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(modifier.name);
  const [price, setPrice] = useState((modifier.priceCents / 100).toFixed(2));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSave(name.trim(), price);
      }}
      className="flex items-center gap-2 text-sm"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-40 rounded border border-slate-300 px-2 py-0.5"
        autoFocus
      />
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
        className="w-20 rounded border border-slate-300 px-2 py-0.5"
      />
      <button type="submit" className="text-xs text-brayz hover:underline">
        Save
      </button>
      <button type="button" onClick={onCancel} className="text-xs text-slate-500 hover:underline">
        Cancel
      </button>
    </form>
  );
}

function AddGroup({
  onAdd,
  busy,
}: {
  onAdd: (v: { name: string; selectionType: 'single' | 'multi'; required: boolean }) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [selectionType, setSelectionType] = useState<'single' | 'multi'>('single');
  const [required, setRequired] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onAdd({ name: name.trim(), selectionType, required });
          setName('');
        }
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Group (e.g. Toppings)"
        className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <select
        value={selectionType}
        onChange={(e) => setSelectionType(e.target.value as 'single' | 'multi')}
        className="rounded border border-slate-300 px-2 py-1 text-sm"
      >
        <option value="single">single</option>
        <option value="multi">multi</option>
      </select>
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
        required
      </label>
      <button
        disabled={busy}
        className="rounded border border-slate-300 px-3 py-1 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      >
        Add group
      </button>
    </form>
  );
}

function AddModifier({ onAdd }: { onAdd: (name: string, price: string) => void }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onAdd(name.trim(), price);
          setName('');
          setPrice('');
        }
      }}
      className="ml-2 mt-1 flex gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Option (e.g. Extra cheese)"
        className="flex-1 rounded border border-slate-300 px-2 py-1 text-xs"
      />
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        className="w-16 rounded border border-slate-300 px-2 py-1 text-xs"
      />
      <button className="rounded border border-slate-300 px-2 py-1 text-xs font-medium hover:bg-slate-50">
        Add
      </button>
    </form>
  );
}

function AddCategory({ onAdd, busy }: { onAdd: (name: string) => void; busy: boolean }) {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onAdd(name.trim());
          setName('');
        }
      }}
      className="flex gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New category (e.g. Pizza)"
        className="flex-1 rounded-lg border border-slate-300 px-3 py-2"
      />
      <button
        disabled={busy}
        className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        Add category
      </button>
    </form>
  );
}

function CategoryHeader({
  name,
  itemCount,
  canManage,
  onRename,
  onDelete,
}: {
  id: string;
  name: string;
  itemCount: number;
  canManage: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const v = value.trim();
          if (v && v !== name) onRename(v);
          setEditing(false);
        }}
        className="flex items-center gap-2"
      >
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded border border-slate-300 px-2 py-1 text-sm font-semibold"
        />
        <button className="text-xs font-medium text-brayz hover:underline">Save</button>
        <button
          type="button"
          onClick={() => {
            setValue(name);
            setEditing(false);
          }}
          className="text-xs text-slate-500 hover:underline"
        >
          Cancel
        </button>
      </form>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <h2 className="font-semibold">{name}</h2>
      {canManage && (
        <span className="flex items-center gap-3">
          <button onClick={() => setEditing(true)} className="text-xs text-brayz hover:underline">
            Rename
          </button>
          <button
            onClick={() => {
              if (
                itemCount === 0 ||
                confirm(`Delete "${name}" and its ${itemCount} item${itemCount === 1 ? '' : 's'}?`)
              )
                onDelete();
            }}
            className="text-xs text-red-500 hover:underline"
          >
            Delete
          </button>
        </span>
      )}
    </div>
  );
}

function EditItem({
  item,
  busy,
  onSave,
  onCancel,
}: {
  item: MenuItem;
  busy: boolean;
  onSave: (body: { name?: string; priceCents?: number; available?: boolean; ingredients?: string[]; upsellTags?: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState((item.priceCents / 100).toFixed(2));
  const [available, setAvailable] = useState(item.available);
  const [ingredients, setIngredients] = useState((item.ingredients ?? []).join(', '));
  const [upsellTags, setUpsellTags] = useState((item.upsellTags ?? []).join(', '));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim())
          onSave({
            name: name.trim(),
            priceCents: parseMoney(price),
            available,
            ingredients: ingredients.split(',').map((s) => s.trim()).filter(Boolean),
            upsellTags: upsellTags
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          });
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="min-w-40 flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      />
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
        className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      />
      <input
        value={ingredients}
        onChange={(e) => setIngredients(e.target.value)}
        placeholder="ingredients (comma-separated)"
        className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      />
      <label className="w-full">
        <input
          value={upsellTags}
          onChange={(e) => setUpsellTags(e.target.value)}
          placeholder="offer this with… e.g. pizza, pasta"
          className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
        />
        <span className="mt-1 block text-xs text-slate-500">
          The bot offers this item as an add-on when the order contains something matching one of
          these — an item name or a menu category.
        </span>
      </label>
      <label className="flex items-center gap-1 text-xs text-slate-600">
        <input type="checkbox" checked={available} onChange={(e) => setAvailable(e.target.checked)} />
        available
      </label>
      <button
        disabled={busy}
        className="rounded-lg bg-brayz px-3 py-1.5 text-sm font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
      >
        Save
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50"
      >
        Cancel
      </button>
    </form>
  );
}

function AddItem({ onAdd, busy }: { onAdd: (name: string, price: string) => void; busy: boolean }) {
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onAdd(name.trim(), price);
          setName('');
          setPrice('');
        }
      }}
      className="mt-3 flex gap-2"
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Item name"
        className="flex-1 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      />
      <input
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        className="w-24 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
      />
      <button
        disabled={busy}
        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-50 disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}
