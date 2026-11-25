import { promises as dns } from 'node:dns';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ImportMenuInput, getMenuTemplate, suggestMenuTemplate } from '@brayz/shared';
import {
  AnthropicMenuExtractor,
  type ExtractionImage,
  type MenuExtractionInput,
  type MenuExtractor,
} from '@brayz/ai';
import { loadConfig } from '@brayz/config';
import { forTenant, prisma, type TenantScopedClient } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { attachTemplateGroups } from '../lib/menuTemplates.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export interface MenuImportRouteOptions {
  /** Inject an extractor (tests). `undefined` → build from config; `null` → unconfigured. */
  extractor?: MenuExtractor | null;
}

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * AI menu importer: extract a menu from a URL / photo / PDF / text into a
 * structured preview (no DB write), then bulk-create the reviewed result.
 * Manager-gated; the extractor is provider-agnostic (CLAUDE.md rule #2).
 */
export async function menuImportRoutes(app: FastifyInstance, opts: MenuImportRouteOptions = {}): Promise<void> {
  const extractor = opts.extractor === undefined ? buildExtractor() : opts.extractor;

  // Extract (no write). Accepts multipart fields: url, text, file (image/pdf/text).
  app.post('/v1/locations/:locationId/menu/import/preview', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(forTenant(tenantId), locationId);
    if (!extractor) throw notConfigured();

    const input = await collectInput(request);
    if (!input.text && !input.images?.length && !input.pdfBase64) {
      throw new HttpError(400, 'Provide a url, text, or file to import', 'no_input');
    }
    try {
      const menu = await extractor.extract(input);
      // Which template's option groups fit what was read, so the review
      // step can offer it pre-selected; null when nothing fits.
      return reply.send({ menu, suggestedTemplateId: suggestMenuTemplate(menu.categories)?.id ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Extraction failed';
      throw new HttpError(502, message, 'extraction_failed');
    }
  });

  // Commit the (user-reviewed) structure.
  app.post('/v1/locations/:locationId/menu/import', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    await assertLocation(db, locationId);
    const body = parse(ImportMenuInput, request.body);
    const template = body.templateId ? getMenuTemplate(body.templateId) : undefined;
    if (body.templateId && !template) {
      throw new HttpError(404, `No menu template "${body.templateId}"`, 'template_not_found');
    }

    const menu = await ensureMenu(db, tenantId, locationId);
    const norm = (s: string) => s.trim().toLowerCase();

    const result = await prisma.$transaction(async (tx) => {
      let added = 0;
      let updated = 0;
      let removed = 0;
      let categoriesCreated = 0;
      // Items this import creates; the template's groups go on these alone.
      // An item that already existed keeps whatever groups its owner gave it.
      const createdIds: string[] = [];
      const withGroups = async () => {
        if (!template || !createdIds.length) return {};
        return attachTemplateGroups(tx, menu.id, template, createdIds);
      };

      if (body.mode === 'merge') {
        const existingCats = await tx.menuCategory.findMany({
          where: { menuId: menu.id },
          include: { items: { select: { id: true, name: true } } },
        });
        const catByName = new Map(existingCats.map((c) => [norm(c.name), c]));
        const itemByName = new Map<string, { id: string }>();
        for (const c of existingCats) for (const it of c.items) itemByName.set(norm(it.name), it);
        const seen = new Set<string>();

        for (const [index, cat] of body.categories.entries()) {
          let category = catByName.get(norm(cat.name));
          if (!category) {
            const c = await tx.menuCategory.create({
              data: { menuId: menu.id, name: cat.name, sortOrder: existingCats.length + index },
            });
            category = { ...c, items: [] };
            catByName.set(norm(cat.name), category);
            categoriesCreated += 1;
          }
          for (const i of cat.items) {
            seen.add(norm(i.name));
            const existing = itemByName.get(norm(i.name));
            if (existing) {
              await tx.menuItem.update({
                where: { id: existing.id },
                data: { priceCents: i.priceCents, description: i.description ?? null, ingredients: i.ingredients ?? [] },
              });
              updated += 1;
            } else {
              const created = await tx.menuItem.create({
                data: { categoryId: category.id, name: i.name, priceCents: i.priceCents, description: i.description, ingredients: i.ingredients ?? [] },
              });
              createdIds.push(created.id);
              added += 1;
            }
          }
        }
        for (const [n, it] of itemByName) {
          if (!seen.has(n)) {
            await tx.menuItem.delete({ where: { id: it.id } });
            removed += 1;
          }
        }
        // Drop categories left empty after the reconcile (e.g. old duplicates).
        await tx.menuCategory.deleteMany({ where: { menuId: menu.id, items: { none: {} } } });
        return { mode: 'merge' as const, added, updated, removed, categoriesCreated, ...(await withGroups()) };
      }

      // replace wipes first; replace + append then create everything fresh.
      if (body.mode === 'replace') {
        await tx.menuCategory.deleteMany({ where: { menuId: menu.id } });
      }
      for (const [index, cat] of body.categories.entries()) {
        const created = await tx.menuCategory.create({
          data: { menuId: menu.id, name: cat.name, sortOrder: index },
        });
        categoriesCreated += 1;
        if (cat.items.length) {
          const rows = await tx.menuItem.createManyAndReturn({
            data: cat.items.map((i) => ({
              categoryId: created.id,
              name: i.name,
              priceCents: i.priceCents,
              description: i.description,
              ingredients: i.ingredients ?? [],
            })),
            select: { id: true },
          });
          createdIds.push(...rows.map((r) => r.id));
          added += cat.items.length;
        }
      }
      return { mode: body.mode, added, updated, removed, categoriesCreated, ...(await withGroups()) };
    });

    return reply.status(201).send(result);
  });
}

/** Parse the multipart body into a normalized extraction input. */
async function collectInput(request: FastifyRequest): Promise<MenuExtractionInput> {
  const images: ExtractionImage[] = [];
  let text: string | undefined;
  let pdfBase64: string | undefined;
  let url: string | undefined;

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buf = await part.toBuffer();
      if (buf.length > MAX_BYTES) throw new HttpError(413, 'File too large (max 10 MB)', 'file_too_large');
      const mime = part.mimetype;
      if (IMAGE_TYPES.has(mime)) {
        images.push({ base64: buf.toString('base64'), mediaType: mime as ExtractionImage['mediaType'] });
      } else if (mime === 'application/pdf') {
        pdfBase64 = buf.toString('base64');
      } else {
        text = buf.toString('utf8');
      }
    } else if (part.fieldname === 'url') {
      url = String(part.value).trim();
    } else if (part.fieldname === 'text') {
      text = String(part.value);
    }
  }

  if (url) {
    const fetched = await fetchUrl(url);
    if (fetched.kind === 'image') images.push({ base64: fetched.base64, mediaType: fetched.mediaType });
    else if (fetched.kind === 'pdf') pdfBase64 = fetched.base64;
    else text = (text ? `${text}\n\n` : '') + fetched.text;
  }
  return { text, images: images.length ? images : undefined, pdfBase64 };
}

type FetchedContent =
  | { kind: 'image'; base64: string; mediaType: ExtractionImage['mediaType'] }
  | { kind: 'pdf'; base64: string }
  | { kind: 'text'; text: string };

/** SSRF-guarded fetch of a menu URL; returns image/pdf bytes or page text. */
async function fetchUrl(raw: string): Promise<FetchedContent> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL', 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new HttpError(400, 'Only http(s) URLs are allowed', 'bad_url');
  }
  const { address } = await dns.lookup(u.hostname).catch(() => {
    throw new HttpError(400, 'Could not resolve URL host', 'bad_url');
  });
  if (isPrivateAddress(address)) {
    throw new HttpError(400, 'URL host is not allowed', 'blocked_url');
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(u.toString(), { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new HttpError(502, `Fetch failed (${res.status})`, 'fetch_failed');
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_BYTES) throw new HttpError(413, 'Remote file too large', 'file_too_large');
    const imageType = [...IMAGE_TYPES].find((t) => ct.includes(t)) as ExtractionImage['mediaType'] | undefined;
    if (imageType) return { kind: 'image', base64: bytes.toString('base64'), mediaType: imageType };
    if (ct.includes('application/pdf')) return { kind: 'pdf', base64: bytes.toString('base64') };
    return { kind: 'text', text: htmlToText(bytes.toString('utf8')) };
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateAddress(ip: string): boolean {
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return true;
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

/** Strip scripts/styles/tags to plain text and cap length. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100_000);
}

function buildExtractor(): MenuExtractor | null {
  const cfg = loadConfig();
  if (!cfg.ANTHROPIC_API_KEY) return null;
  return new AnthropicMenuExtractor({ apiKey: cfg.ANTHROPIC_API_KEY, model: cfg.MENU_EXTRACTION_MODEL });
}

const notConfigured = () =>
  new HttpError(503, 'Menu import is not configured (ANTHROPIC_API_KEY missing)', 'extractor_not_configured');

async function assertLocation(db: TenantScopedClient, locationId: string): Promise<void> {
  const loc = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!loc) throw notFound('Location');
}

async function ensureMenu(db: TenantScopedClient, tenantId: string, locationId: string) {
  const existing = await db.menu.findFirst({ where: { locationId, active: true } });
  if (existing) return existing;
  return db.menu.create({ data: { tenantId, locationId, name: 'Main Menu' } });
}
