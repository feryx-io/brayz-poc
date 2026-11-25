'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { parseMoney, useMenuTemplates } from '@/lib/queries';

interface ExtractedMenu {
  categories: Array<{
    name: string;
    items: Array<{ name: string; priceCents: number; description?: string; ingredients?: string[] }>;
  }>;
}
interface EditItem {
  name: string;
  price: string;
  description?: string;
  ingredients: string;
}
interface EditCategory {
  name: string;
  items: EditItem[];
}

/**
 * AI menu importer: paste a URL, upload a photo/PDF, or paste text → Claude
 * extracts a structured menu → owner reviews/edits → bulk import.
 */
export function MenuImport({
  locationId,
  onClose,
  onImported,
}: {
  locationId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const { api, apiForm } = useAuth();
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<EditCategory[] | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace' | 'append'>('merge');
  // Option groups for what gets imported (toppings on a pizza, sauce on
  // wings). The API suggests the template that fits what it read; '' is none.
  const templates = useMenuTemplates();
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPreview(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      if (url.trim()) form.set('url', url.trim());
      if (text.trim()) form.set('text', text);
      if (file) form.set('file', file);
      if (![...form.keys()].length) throw new Error('Add a URL, paste text, or choose a file.');
      const res = await apiForm<{ menu: ExtractedMenu; suggestedTemplateId?: string | null }>(
        `/v1/locations/${locationId}/menu/import/preview`,
        form,
      );
      setTemplateId(res.suggestedTemplateId ?? '');
      setPreview(
        res.menu.categories.map((c) => ({
          name: c.name,
          items: c.items.map((i) => ({
            name: i.name,
            price: (i.priceCents / 100).toFixed(2),
            description: i.description,
            ingredients: (i.ingredients ?? []).join(', '),
          })),
        })),
      );
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const categories = preview
        .map((c) => ({
          name: c.name.trim(),
          items: c.items
            .filter((i) => i.name.trim())
            .map((i) => ({
              name: i.name.trim(),
              priceCents: parseMoney(i.price),
              description: i.description,
              ingredients: i.ingredients.split(',').map((s) => s.trim()).filter(Boolean),
            })),
        }))
        .filter((c) => c.name && c.items.length);
      if (!categories.length) throw new Error('Nothing to import.');
      await api(`/v1/locations/${locationId}/menu/import`, {
        method: 'POST',
        body: { mode, categories, ...(templateId ? { templateId } : {}) },
      });
      onImported();
      onClose();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  const itemCount = preview?.reduce((n, c) => n + c.items.length, 0) ?? 0;
  const update = (ci: number, fn: (c: EditCategory) => EditCategory) =>
    setPreview((p) => p!.map((c, i) => (i === ci ? fn(c) : c)));

  return (
    <div className="rounded-xl border border-brayz/30 bg-white p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold">Import menu {preview ? '— review' : ''}</h2>
        <button onClick={onClose} className="text-sm text-slate-500 hover:text-brayz">
          Close
        </button>
      </div>

      {!preview ? (
        <form className="space-y-3" onSubmit={onPreview}>
          <label className="block">
            <span className="text-sm font-medium">Menu URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://yourrestaurant.com/menu"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Photo / PDF</span>
            <input
              type="file"
              accept="image/*,application/pdf,.txt,.csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="mt-1 block w-full text-sm"
            />
          </label>
          <label className="block">
            <span className="text-sm font-medium">Or paste menu text</span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
          >
            {busy ? 'Reading menu…' : 'Preview with AI'}
          </button>
          {busy && <p className="text-xs text-slate-400">A large menu can take up to a minute.</p>}
        </form>
      ) : (
        <div>
          <p className="mb-3 text-sm text-slate-500">
            Review and edit before importing. Remove anything wrong — nothing is saved until you click import.
          </p>
          <div className="max-h-96 space-y-4 overflow-y-auto pr-1">
            {preview.map((cat, ci) => (
              <div key={ci} className="rounded-lg border border-slate-200 p-3">
                <input
                  value={cat.name}
                  onChange={(e) => update(ci, (c) => ({ ...c, name: e.target.value }))}
                  className="mb-2 w-full rounded border border-slate-200 px-2 py-1 text-sm font-semibold"
                />
                <ul className="space-y-1">
                  {cat.items.map((item, ii) => (
                    <li key={ii} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <input
                          value={item.name}
                          onChange={(e) =>
                            update(ci, (c) => ({
                              ...c,
                              items: c.items.map((it, j) => (j === ii ? { ...it, name: e.target.value } : it)),
                            }))
                          }
                          className="flex-1 rounded border border-slate-200 px-2 py-1 text-sm"
                        />
                        <input
                          value={item.price}
                          onChange={(e) =>
                            update(ci, (c) => ({
                              ...c,
                              items: c.items.map((it, j) => (j === ii ? { ...it, price: e.target.value } : it)),
                            }))
                          }
                          inputMode="decimal"
                          className="w-20 rounded border border-slate-200 px-2 py-1 text-sm tabular-nums"
                        />
                        <button
                          onClick={() =>
                            update(ci, (c) => ({ ...c, items: c.items.filter((_, j) => j !== ii) }))
                          }
                          className="text-xs text-red-500 hover:underline"
                        >
                          ✕
                        </button>
                      </div>
                      <input
                        value={item.ingredients}
                        onChange={(e) =>
                          update(ci, (c) => ({
                            ...c,
                            items: c.items.map((it, j) => (j === ii ? { ...it, ingredients: e.target.value } : it)),
                          }))
                        }
                        placeholder="ingredients (comma-separated)"
                        className="w-full rounded border border-slate-100 bg-slate-50 px-2 py-1 text-xs text-slate-600"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-lg bg-slate-50 p-3">
            <p className="mb-1 text-xs font-medium text-slate-600">How should this apply to your current menu?</p>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="merge">Update — update matching items, add new, remove ones not listed here</option>
              <option value="replace">Replace — wipe the current menu and use only this</option>
              <option value="append">Add — keep the current menu and add these (may duplicate)</option>
            </select>
            {mode === 'merge' && (
              <p className="mt-1.5 text-xs text-amber-700">
                Items in your menu that aren’t shown above will be removed, and modifier groups on kept items are preserved.
              </p>
            )}
            {mode === 'replace' && (
              <p className="mt-1.5 text-xs text-red-600">
                This deletes your entire current menu (including modifier groups) and replaces it with the items above.
              </p>
            )}
          </div>
          <div className="mt-3 rounded-lg bg-slate-50 p-3">
            <p className="mb-1 text-xs font-medium text-slate-600">
              Set up the choices a caller makes (toppings, sauces, bread) on the new items?
            </p>
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">No — import the items only</option>
              {templates.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  Yes — use the {t.name} option groups
                </option>
              ))}
            </select>
            {templateId && (
              <p className="mt-1.5 text-xs text-slate-500">
                Only items this import creates get groups; items you already have keep theirs. Option prices are typical
                numbers — check them against yours in the editor.
              </p>
            )}
          </div>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={onImport}
              disabled={busy || itemCount === 0}
              className="rounded-lg bg-brayz px-4 py-2 font-medium text-white hover:bg-brayz-dark disabled:opacity-50"
            >
              {busy ? 'Importing…' : `${mode === 'replace' ? 'Replace with' : mode === 'merge' ? 'Update menu —' : 'Add'} ${itemCount} item${itemCount === 1 ? '' : 's'}`}
            </button>
            <button onClick={() => setPreview(null)} className="text-sm text-slate-500 hover:text-brayz">
              Start over
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('503') || msg.includes('extractor_not_configured')) {
    return 'Menu import isn’t configured yet (Claude key missing). Ask an admin.';
  }
  if (msg.includes('blocked_url') || msg.includes('bad_url')) return 'That URL couldn’t be used. Try another or paste text.';
  return msg;
}
