import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { LlmMessage, LlmProvider, LlmToolCall, LlmToolDefinition } from '@brayz/ai';
import { prisma } from '@brayz/db';
import {
  MENU_TEMPLATES,
  MenuHealthFixInput,
  defaultAllowsHalves,
  getMenuTemplate,
  normalizeTerm,
  suggestMenuTemplate,
  templateGroupsFor,
  type AssistantMessage,
  type AssistantProposal,
  type MenuFixGroup,
  type MenuHealthFinding,
  type MenuHealthFix,
  type MenuTemplate,
} from '@brayz/shared';
import { analyzeMenu, loadMenuSnapshot } from './menuHealth.js';

/**
 * The per-account assistant: a conversation over one location's menu, calls
 * and settings, for the owner or manager fixing why the bot handled a call
 * badly.
 *
 * Every defect found on a real call has been a menu fact the bot lacked, and
 * each one took a person reading a transcript to find. This puts the reading
 * on the model: it can pull the menu, the health findings, what callers asked
 * for that the menu could not sell, and any recent call with its transcript
 * and ticket, and say what it sees in the owner's own terms.
 *
 * What it can do about it is deliberately narrow. It never writes. It may
 * *propose* an edit — a group to add, an option, a price, availability, halves
 * — as a structured fix the dashboard renders with an Apply button, and
 * applying it is the same menu route the editor uses, under the same role
 * check and audit entry. The assistant can be wrong; a proposal costs nothing
 * until a person accepts it. Facts come from tools: it is told never to name
 * a price or an option it did not read.
 *
 * Build mode is the same idea pointed at what the menu lacks rather than
 * what it has. The menu templates (`@brayz/shared`) are the reference: the
 * assistant can read what a typical restaurant of this kind sells and which
 * option groups each item carries, and propose a section or an item from
 * it. An item proposal arrives with the template's groups already on it —
 * the rules that decide which groups an item gets are code, not the model's
 * recall — and without a price unless the owner gave one, so it is created
 * hidden, as a template's starter item is. The bot never quotes a guess.
 *
 * Stateless per request: the dashboard holds the thread and sends it back.
 * Tenant and location are fixed by the route and threaded through every
 * tool; no argument the model passes can move them (rule #1).
 */

export const ASSISTANT_TOOLS: LlmToolDefinition[] = [
  {
    name: 'get_menu_health',
    description:
      'Findings about what on this menu will make the phone bot handle a call badly, from the menu and ' +
      'from what callers asked for in the period. Each finding may carry a ready-made fix.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_menu',
    description:
      'The whole menu: sections, items with ids, prices and availability, and each item’s option groups ' +
      'with their options, ids and prices. Use the ids from here in propose_edit.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_menu_gaps',
    description: 'What callers asked for in the period that the menu does not sell, most-asked first.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_recent_calls',
    description: 'The most recent calls in the period: when, caller, outcome, summary, order total.',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 20.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_call',
    description: 'One call in full: its transcript, summary, and the order it produced, line by line.',
    parameters: {
      type: 'object',
      properties: { call_id: { type: 'string', description: 'From list_recent_calls.' } },
      required: ['call_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_menu_template',
    description:
      'What a typical restaurant of this kind sells: a template’s sections and starter items, which ' +
      'sections this menu already has, and the library of option groups (with options and typical ' +
      'prices) its rules would put on an item. Use it before proposing a new section or item. With no ' +
      'template_id it picks the template that fits this menu, or lists the templates if none does.',
    parameters: {
      type: 'object',
      properties: { template_id: { type: 'string', description: 'A template id, e.g. pizzeria or deli.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'propose_edit',
    description:
      'Suggest one menu edit. Nothing is changed: the owner sees it with an Apply button. Use ids from ' +
      'get_menu or get_menu_health. Kinds: create_group (item_id, name, selection_type single|multi, ' +
      'required, max_selections?, modifiers [{name, price_cents}]), add_modifier (group_id, name, ' +
      'price_cents), allow_halves (group_id), update_item (item_id, name?, price_cents?, available?), ' +
      'update_modifier (modifier_id, name?, price_cents?, available?), create_category (name), ' +
      'create_item (category — the section name, created if missing; name; description?; price_cents ' +
      'only if the owner said the price; ingredients?; template_id? — the item gets that template’s ' +
      'option groups for an item of its name and section; groups? [{name, selection_type, required, ' +
      'max_selections?, modifiers}] to give your own instead).',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'One line, as the owner will read it on the button.' },
        reason: { type: 'string', description: 'Why, citing what you read — a finding, a call, an ask count.' },
        fix: { type: 'object', description: 'The edit, in the shape described above.', additionalProperties: true },
      },
      required: ['summary', 'reason', 'fix'],
      additionalProperties: false,
    },
  },
];

export function buildAssistantSystemPrompt(location: { name: string; timezone: string }, days: number): string {
  return [
    `You are the Brayz assistant for ${location.name}, talking with the restaurant's owner or manager.`,
    'Brayz answers their phone with an AI receptionist that takes pickup and delivery orders from the menu. Your',
    'job is to help them see why a call went the way it did and fix the menu or settings behind it.',
    '',
    'Rules:',
    `- Everything you say about the menu or calls comes from the tools. The period is the last ${days} days.`,
    '  Never state a price, an option, an item or what a caller said unless a tool returned it.',
    '- Be brief and plain. Two to five sentences, then a proposal if one is warranted. Plain text',
    '  only: no markdown, no bold, no bullet points, no headings — it is shown as typed.',
    '- When a fix is a plain menu edit, call propose_edit with it rather than describing it; the owner',
    '  gets a button. One proposal per edit. Say in a few words what each does. Never claim it is done.',
    '- Building out the menu is also a proposal. When the owner wants a section or an item the menu',
    '  lacks, read get_menu_template first and propose create_category or create_item from it, one',
    '  proposal per item. Leave price_cents out unless the owner stated the price — an unpriced item is',
    '  created hidden until they price it, and you must say so. Never make up a price. Do not propose an',
    '  item or a section the menu already has; check get_menu.',
    '- Some things are not menu edits: deleting an item or a section, or a setting like hours or',
    '  transfer rules. Say where in the dashboard to do those.',
    '- Prices are in cents in tool results and in proposals; say them in dollars to the owner.',
    '- Callers are the restaurant’s guests. Refer to them by what they ordered or when they called, not',
    '  by phone number, unless the owner asks for it.',
    '- If asked something the tools cannot answer, say so rather than guess.',
  ].join('\n');
}

export interface AssistantRunOptions {
  llm: LlmProvider;
  tenantId: string;
  locationId: string;
  location: { name: string; timezone: string };
  days: number;
  messages: AssistantMessage[];
  log: FastifyBaseLogger;
  /** Model passes per request. Each tool round trip is one. */
  maxPasses?: number;
}

export interface AssistantRunResult {
  reply: string;
  proposals: AssistantProposal[];
  toolsUsed: string[];
}

export async function runAssistant(opts: AssistantRunOptions): Promise<AssistantRunResult> {
  const maxPasses = opts.maxPasses ?? 6;
  const since = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000);
  const history: LlmMessage[] = [
    { role: 'system', content: buildAssistantSystemPrompt(opts.location, opts.days) },
    ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const proposals: AssistantProposal[] = [];
  const toolsUsed: string[] = [];
  let reply = '';

  for (let pass = 0; pass < maxPasses; pass++) {
    let text = '';
    const calls: LlmToolCall[] = [];
    await opts.llm.stream({
      messages: history,
      tools: ASSISTANT_TOOLS,
      onEvent: (e) => {
        if (e.type === 'text' && e.textDelta) text += e.textDelta;
        else if (e.type === 'tool_call' && e.toolCall) calls.push(e.toolCall);
      },
    });
    history.push({ role: 'assistant', content: text, toolCalls: calls.length ? calls : undefined });
    if (text.trim()) reply = text.trim();
    if (!calls.length) break;

    for (const call of calls) {
      toolsUsed.push(call.name);
      let result: string;
      try {
        result = await runTool(call, { ...opts, since, proposals });
      } catch (err) {
        opts.log.warn({ err, tool: call.name, locationId: opts.locationId }, 'assistant tool failed');
        result = 'That could not be read right now.';
      }
      history.push({ role: 'tool', toolCallId: call.id, content: result });
    }
    if (pass === maxPasses - 1) {
      // Out of passes with tools still being called: the last text stands,
      // or an honest note if there was none.
      if (!reply) reply = 'I ran out of steps before I could finish that. Ask again more narrowly.';
    }
  }
  return { reply, proposals, toolsUsed };
}

interface ToolContext {
  tenantId: string;
  locationId: string;
  days: number;
  since: Date;
  proposals: AssistantProposal[];
}

async function runTool(call: LlmToolCall, ctx: ToolContext): Promise<string> {
  switch (call.name) {
    case 'get_menu_health': {
      const findings = analyzeMenu(await loadMenuSnapshot(ctx.tenantId, ctx.locationId, ctx.since));
      if (!findings.length) return `No findings: nothing about the menu or the last ${ctx.days} days of calls needs fixing.`;
      return JSON.stringify(findings.map(compactFinding));
    }
    case 'get_menu': {
      const menu = await prisma.menu.findFirst({
        where: { tenantId: ctx.tenantId, locationId: ctx.locationId, active: true },
        select: {
          categories: {
            orderBy: { sortOrder: 'asc' },
            select: {
              name: true,
              items: {
                orderBy: { name: 'asc' },
                select: {
                  id: true,
                  name: true,
                  description: true,
                  priceCents: true,
                  available: true,
                  modifierGroups: {
                    select: {
                      id: true,
                      name: true,
                      selectionType: true,
                      required: true,
                      maxSelections: true,
                      allowsHalves: true,
                      modifiers: { select: { id: true, name: true, priceCents: true, available: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!menu) return 'This location has no active menu yet.';
      return JSON.stringify(
        menu.categories.map((c) => ({
          section: c.name,
          items: c.items.map((i) => ({
            id: i.id,
            name: i.name,
            description: i.description ?? undefined,
            price_cents: i.priceCents,
            available: i.available,
            groups: i.modifierGroups.map((g) => ({
              id: g.id,
              name: g.name,
              selection: g.selectionType,
              required: g.required,
              max: g.maxSelections ?? undefined,
              halves: g.allowsHalves,
              options: g.modifiers.map((o) => ({ id: o.id, name: o.name, price_cents: o.priceCents, available: o.available })),
            })),
          })),
        })),
      );
    }
    case 'get_menu_gaps': {
      const rows = await prisma.menuGap.findMany({
        where: { tenantId: ctx.tenantId, locationId: ctx.locationId, createdAt: { gte: ctx.since } },
        select: { term: true, rawTerm: true, kind: true, onItem: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      const byTerm = new Map<string, { asked_for: string; kind: string; on_items: Set<string>; times: number; last: Date }>();
      for (const r of rows) {
        const seen = byTerm.get(r.term);
        if (seen) {
          seen.times += 1;
          if (r.onItem) seen.on_items.add(r.onItem);
        } else byTerm.set(r.term, { asked_for: r.rawTerm, kind: r.kind, on_items: new Set(r.onItem ? [r.onItem] : []), times: 1, last: r.createdAt });
      }
      if (!byTerm.size) return `Callers asked for nothing the menu lacks in the last ${ctx.days} days.`;
      return JSON.stringify(
        [...byTerm.values()]
          .sort((a, b) => b.times - a.times)
          .map((g) => ({ ...g, on_items: [...g.on_items], last: g.last.toISOString() })),
      );
    }
    case 'list_recent_calls': {
      const limit = Math.min(50, Math.max(1, Number(call.arguments.limit) || 20));
      const calls = await prisma.call.findMany({
        where: { tenantId: ctx.tenantId, locationId: ctx.locationId, startedAt: { gte: ctx.since } },
        orderBy: { startedAt: 'desc' },
        take: limit,
        select: {
          id: true,
          startedAt: true,
          endedAt: true,
          fromNumber: true,
          status: true,
          summary: true,
          orders: { where: { status: { not: 'canceled' } }, select: { totalCents: true, customerName: true } },
        },
      });
      if (!calls.length) return `No calls in the last ${ctx.days} days.`;
      return JSON.stringify(
        calls.map((c) => ({
          call_id: c.id,
          started: c.startedAt.toISOString(),
          seconds: c.endedAt ? Math.round((c.endedAt.getTime() - c.startedAt.getTime()) / 1000) : null,
          from: c.fromNumber,
          status: c.status,
          summary: c.summary,
          order_total_cents: c.orders.length ? c.orders.reduce((s, o) => s + o.totalCents, 0) : null,
          customer: c.orders.find((o) => o.customerName)?.customerName ?? null,
        })),
      );
    }
    case 'get_call': {
      const id = typeof call.arguments.call_id === 'string' ? call.arguments.call_id : '';
      const c = id
        ? await prisma.call.findFirst({
            where: { id, tenantId: ctx.tenantId, locationId: ctx.locationId },
            select: {
              id: true,
              startedAt: true,
              status: true,
              summary: true,
              transcript: { select: { turns: true } },
              orders: {
                where: { status: { not: 'canceled' } },
                select: {
                  customerName: true,
                  totalCents: true,
                  items: {
                    select: {
                      name: true,
                      quantity: true,
                      specialInstructions: true,
                      modifiers: { select: { name: true, portion: true, priceCents: true } },
                    },
                  },
                },
              },
            },
          })
        : null;
      if (!c) return 'No such call at this location. Use a call_id from list_recent_calls.';
      const turns = Array.isArray(c.transcript?.turns) ? (c.transcript!.turns as Array<{ speaker: string; text: string }>) : [];
      return JSON.stringify({
        call_id: c.id,
        started: c.startedAt.toISOString(),
        status: c.status,
        summary: c.summary,
        transcript: turns.map((t) => `${t.speaker === 'agent' ? 'Bot' : 'Caller'}: ${t.text}`),
        orders: c.orders.map((o) => ({
          customer: o.customerName,
          total_cents: o.totalCents,
          lines: o.items.map((l) => ({
            item: l.name,
            qty: l.quantity,
            options: l.modifiers.map((m) => (m.portion && m.portion !== 'whole' ? `${m.name} (${m.portion} half)` : m.name)),
            note: l.specialInstructions ?? undefined,
          })),
        })),
      });
    }
    case 'get_menu_template': {
      const id = typeof call.arguments.template_id === 'string' ? call.arguments.template_id.trim() : '';
      const template = id ? getMenuTemplate(id) : await fittingTemplate(ctx);
      if (!template) {
        if (id) return `No template "${id}". ${templateList()}`;
        return `No template clearly fits this menu. ${templateList()} Call again with a template_id.`;
      }
      const sections = await menuSectionNames(ctx);
      return JSON.stringify({
        template_id: template.id,
        name: template.name,
        sections: template.categories.map((c) => ({
          name: c.name,
          on_menu: sections.has(normalizeTerm(c.name)),
          starter_items: c.items.map((i) => ({
            name: i.name,
            description: i.description,
            groups: templateGroupsFor(template, { name: i.name, category: c.name }).map((g) => g.spec.name),
          })),
        })),
        groups: Object.values(template.groups).map((g) => ({
          name: g.name,
          selection: g.selectionType,
          required: g.required,
          max: g.maxSelections,
          options: g.options.map((o) => ({ name: o.name, price_cents: o.priceCents })),
        })),
        note: 'Option prices are typical, not this restaurant’s. Starter items have no price.',
      });
    }
    case 'propose_edit': {
      const summary = typeof call.arguments.summary === 'string' ? call.arguments.summary.trim() : '';
      const reason = typeof call.arguments.reason === 'string' ? call.arguments.reason.trim() : '';
      const raw = camelize(call.arguments.fix) as Record<string, unknown> | undefined;
      // template_id is instruction to this tool, not part of the edit: the
      // groups it names are resolved here and travel with the proposal.
      const templateId = raw && typeof raw.templateId === 'string' ? raw.templateId : undefined;
      if (raw) delete raw.templateId;
      const parsed = MenuHealthFixInput.safeParse(raw);
      if (!parsed.success || !summary) {
        return `Not recorded — the edit was not in a shape I can apply: ${parsed.success ? 'missing summary' : parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}. Use the kinds and fields the tool describes, with ids from get_menu.`;
      }
      const fix = parsed.data as MenuHealthFix;
      if (fix.kind === 'create_item' && !fix.groups.length) {
        const template = (templateId ? getMenuTemplate(templateId) : undefined) ?? (await fittingTemplate(ctx));
        if (template) fix.groups = templateGroupsAsFix(template, fix);
      }
      const problem = await checkProposal(fix, ctx.tenantId, ctx.locationId);
      if (problem) return `Not recorded — ${problem}`;
      const proposal: AssistantProposal = { id: crypto.randomUUID(), summary, reason, fix };
      ctx.proposals.push(proposal);
      return `Recorded as a proposal the owner can apply: "${summary}". Do not describe it as done.`;
    }
    default:
      return `Unknown tool: ${call.name}.`;
  }
}

/**
 * Why a proposal cannot stand, or null. An id a fix targets must be on this
 * tenant's, this location's, active menu; a name it would create must not
 * already be there — a second "Pizza" section or a second "Calzone" is the
 * duplicate finding menu health exists to catch, not something to offer.
 */
async function checkProposal(fix: MenuHealthFix, tenantId: string, locationId: string): Promise<string | null> {
  const menuScope = { category: { menu: { tenantId, locationId } } };
  const notHere = 'that id is not on this location’s menu. Use ids from get_menu.';
  switch (fix.kind) {
    case 'create_group':
    case 'update_item':
      return (await prisma.menuItem.findFirst({ where: { id: fix.itemId, ...menuScope }, select: { id: true } })) ? null : notHere;
    case 'update_modifier':
      return (await prisma.modifier.findFirst({ where: { id: fix.modifierId, group: { menuItem: menuScope } }, select: { id: true } }))
        ? null
        : notHere;
    case 'add_modifier':
    case 'allow_halves':
      return (await prisma.modifierGroup.findFirst({ where: { id: fix.groupId, menuItem: menuScope }, select: { id: true } }))
        ? null
        : notHere;
    case 'create_category': {
      const sections = await menuSectionNames({ tenantId, locationId });
      return sections.has(normalizeTerm(fix.name)) ? `the menu already has a "${fix.name}" section.` : null;
    }
    case 'create_item': {
      const items = await prisma.menuItem.findMany({ where: menuScope, select: { name: true } });
      const wanted = normalizeTerm(fix.name);
      const clash = items.find((i) => normalizeTerm(i.name) === wanted);
      return clash ? `the menu already has "${clash.name}". Propose update_item on it instead.` : null;
    }
  }
}

/** The sections on this location's active menu, by normalized name. */
async function menuSectionNames(ctx: { tenantId: string; locationId: string }): Promise<Set<string>> {
  const rows = await prisma.menuCategory.findMany({
    where: { menu: { tenantId: ctx.tenantId, locationId: ctx.locationId, active: true } },
    select: { name: true },
  });
  return new Set(rows.map((c) => normalizeTerm(c.name)));
}

/** The template whose rules fit the most of this menu's items, if one stands out. */
async function fittingTemplate(ctx: { tenantId: string; locationId: string }): Promise<MenuTemplate | undefined> {
  const categories = await prisma.menuCategory.findMany({
    where: { menu: { tenantId: ctx.tenantId, locationId: ctx.locationId, active: true } },
    select: { name: true, items: { select: { name: true } } },
  });
  return suggestMenuTemplate(categories);
}

function templateList(): string {
  return `Templates: ${MENU_TEMPLATES.map((t) => `${t.id} (${t.name})`).join(', ')}.`;
}

/**
 * The groups a template's rules give an item of this name and section, in
 * the shape a fix carries — the same decision `attachTemplateGroups` makes
 * when a template is applied whole, so an item built one at a time through
 * the assistant ends up no different from one the template created.
 */
function templateGroupsAsFix(template: MenuTemplate, item: { name: string; category: string }): MenuFixGroup[] {
  return templateGroupsFor(template, item).map(({ spec }) => ({
    name: spec.name,
    selectionType: spec.selectionType,
    required: spec.required,
    ...(spec.maxSelections ? { maxSelections: spec.maxSelections } : {}),
    allowsHalves: spec.allowsHalves ?? defaultAllowsHalves(item, { name: spec.name, selectionType: spec.selectionType }),
    modifiers: spec.options.map((o) => ({ name: o.name, priceCents: o.priceCents })),
  }));
}

/** Models write snake_case; the fix schema is camelCase. Keys only, recursing into groups and modifiers. */
function camelize(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const key = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[key] = (key === 'modifiers' || key === 'groups') && Array.isArray(val) ? val.map(camelize) : val;
  }
  return out;
}

function compactFinding(f: MenuHealthFinding) {
  return {
    code: f.code,
    severity: f.severity,
    item: f.itemName,
    item_id: f.itemId,
    group_id: f.groupId,
    title: f.title,
    detail: f.detail,
    evidence: f.evidence,
    ready_fix: f.fix,
  };
}
