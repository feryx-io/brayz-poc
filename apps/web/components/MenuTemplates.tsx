'use client';

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { useMenuTemplates, type MenuTemplateSummary } from '@/lib/queries';

/**
 * Pick a menu template and lay it onto this location.
 *
 * Two jobs, one panel. On an empty menu it is the way to start: sections,
 * starter items (unpriced and hidden until the owner prices them — the bot
 * never quotes a template's guess), and the option groups a phone order
 * needs. On a menu that already has items it adds only what is missing:
 * the groups — toppings on a pizza, sauce on wings, bread on a sandwich —
 * for items that have none, leaving every group the owner built alone.
 */
export function MenuTemplates({
  locationId,
  hasItems,
  onApplied,
  onClose,
}: {
  locationId: string;
  hasItems: boolean;
  onApplied: () => void;
  onClose?: () => void;
}) {
  const { api } = useAuth();
  const templates = useMenuTemplates();
  const [selected, setSelected] = useState<string | null>(null);
  const [starterItems, setStarterItems] = useState(!hasItems);
  const [sections, setSections] = useState(!hasItems);
  const [done, setDone] = useState<null | { categoriesCreated: number; itemsCreated: number; groupsCreated: number; itemsGivenGroups: number }>(null);

  const apply = useMutation({
    mutationFn: (templateId: string) =>
      api<{ categoriesCreated: number; itemsCreated: number; groupsCreated: number; itemsGivenGroups: number }>(
        `/v1/locations/${locationId}/menu/template`,
        { method: 'POST', body: { templateId, mode: 'append', sections, starterItems } },
      ),
    onSuccess: (r) => {
      setDone(r);
      onApplied();
    },
  });

  const chosen = templates.data?.find((t) => t.id === selected);

  if (done) {
    return (
      <div className="rounded-xl border border-green-200 bg-green-50 p-5 text-sm">
        <p className="font-medium text-green-800">Template applied.</p>
        <p className="mt-1 text-green-900">
          {done.categoriesCreated > 0 && `${done.categoriesCreated} sections, `}
          {done.itemsCreated > 0 && `${done.itemsCreated} starter items, `}
          {done.groupsCreated} option groups on {done.itemsGivenGroups} items.
        </p>
        {done.itemsCreated > 0 && (
          <p className="mt-2 text-green-900">
            Starter items are hidden until you set a price and mark each one available. Delete any you do not sell.
            Option prices are typical numbers — check them against yours.
          </p>
        )}
        {onClose && (
          <button onClick={onClose} className="mt-3 text-xs text-slate-600 hover:underline">
            Close
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-brayz/30 bg-white p-5">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold">{hasItems ? 'Add option groups from a template' : 'Start from a template'}</h2>
          <p className="text-sm text-slate-500">
            {hasItems
              ? 'Gives items that have no choices yet the ones a phone order needs — toppings, sauces, bread. Groups you already built are left alone.'
              : 'The usual sections and items for your kind of restaurant, with the choices a caller has to make already set up. Prices are yours to fill in.'}
          </p>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-brayz">
            Close
          </button>
        )}
      </div>

      {templates.isLoading && <p className="text-sm text-slate-500">Loading templates…</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {templates.data?.map((t) => (
          <TemplateCard key={t.id} template={t} selected={selected === t.id} onSelect={() => setSelected(t.id)} />
        ))}
      </div>

      {chosen && (
        <div className="mt-4 space-y-3">
          <details className="rounded-lg bg-slate-50 p-3 text-sm">
            <summary className="cursor-pointer font-medium text-slate-700">What {chosen.name} sets up</summary>
            <ul className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {chosen.categories.map((c) => (
                <li key={c.name}>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-slate-500">
                    {' '}
                    — {c.items.length} item{c.items.length === 1 ? '' : 's'}
                    {(() => {
                      const groups = [...new Set(c.items.flatMap((i) => i.groups))];
                      return groups.length ? `, choices: ${groups.join(', ')}` : '';
                    })()}
                  </span>
                </li>
              ))}
            </ul>
          </details>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={sections} onChange={(e) => setSections(e.target.checked)} />
              Add the sections
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={starterItems}
                onChange={(e) => {
                  setStarterItems(e.target.checked);
                  if (e.target.checked) setSections(true);
                }}
              />
              Add starter items (hidden until you price them)
            </label>
          </div>
          {apply.isError && (
            <p className="text-sm text-red-600">{(apply.error as Error).message.replace(/^API \d+ [^:]+: /, '')}</p>
          )}
          <button
            onClick={() => apply.mutate(chosen.id)}
            disabled={apply.isPending}
            className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {apply.isPending ? 'Applying…' : hasItems && !sections && !starterItems ? 'Add option groups' : `Use ${chosen.name}`}
          </button>
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template, selected, onSelect }: { template: MenuTemplateSummary; selected: boolean; onSelect: () => void }) {
  const items = template.categories.reduce((n, c) => n + c.items.length, 0);
  return (
    <button
      onClick={onSelect}
      className={
        'rounded-lg border p-3 text-left text-sm transition ' +
        (selected ? 'border-brayz bg-brayz/5 ring-1 ring-brayz' : 'border-slate-200 hover:border-brayz/60')
      }
    >
      <p className="font-medium">{template.name}</p>
      <p className="mt-1 text-slate-600">{template.description}</p>
      <p className="mt-2 text-xs text-slate-500">
        {template.categories.length} sections · {items} starter items · {template.groups.length} option groups
      </p>
    </button>
  );
}
