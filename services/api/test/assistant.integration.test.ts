import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LlmMessage, LlmProvider, LlmStreamEvent } from '@brayz/ai';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const OWNER_EMAIL = `assistant-owner-${Date.now()}@brayz.test`;
const STAFF_EMAIL = `assistant-staff-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const headersFor = (email: string) => ({
  'x-brayz-user-email': email,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
});

interface Step {
  text?: string;
  tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

/**
 * Says what the script says, one entry per model pass, and remembers every
 * request so a test can read what the tools handed back.
 */
class ScriptedLlm implements LlmProvider {
  readonly name = 'fake-llm';
  script: Step[] = [];
  requests: LlmMessage[][] = [];
  async stream(opts: { messages: LlmMessage[]; onEvent: (e: LlmStreamEvent) => void }): Promise<void> {
    this.requests.push(opts.messages.map((m) => ({ ...m })));
    const step = this.script[this.requests.length - 1] ?? {};
    if (step.text) opts.onEvent({ type: 'text', textDelta: step.text });
    for (const [i, t] of (step.tools ?? []).entries()) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: `t${this.requests.length}-${i}`, name: t.name, arguments: t.arguments ?? {} },
      });
    }
    opts.onEvent({ type: 'done' });
  }
  /** Tool results the model saw on its last request. */
  lastToolResults(): string[] {
    return (this.requests.at(-1) ?? []).filter((m) => m.role === 'tool').map((m) => m.content);
  }
}

describe.skipIf(!dbUp)('Assistant chat', () => {
  let app: App;
  let unconfigured: App;
  let llm: ScriptedLlm;
  let locationId: string;
  let otherLocationId: string;
  let calzoneId: string;
  let otherItemId: string;
  let pizzaGroupId: string;
  const userIds: string[] = [];
  const callIds: string[] = [];

  const chat = (messages: Array<{ role: string; content: string }>, email = OWNER_EMAIL, loc = locationId) =>
    app.inject({
      method: 'POST',
      url: `/v1/locations/${loc}/assistant/chat`,
      headers: headersFor(email),
      payload: { messages },
    });

  beforeAll(async () => {
    llm = new ScriptedLlm();
    app = await buildApp({ notifier: null, assistantLlm: llm });
    unconfigured = await buildApp({ notifier: null, assistantLlm: null });
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [STAFF_EMAIL, 'staff'],
    ] as const) {
      const u = await prisma.user.create({ data: { email, authSubject: email } });
      userIds.push(u.id);
      await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId: u.id, role } });
    }
    const [a, b] = await Promise.all([
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Assistant Kitchen' }, select: { id: true } }),
      prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'Assistant Kitchen B' }, select: { id: true } }),
    ]);
    locationId = a.id;
    otherLocationId = b.id;

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Assistant Menu', active: true },
      select: { id: true },
    });
    const cat = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' }, select: { id: true } });
    const pizza = await prisma.menuItem.create({
      data: { categoryId: cat.id, name: 'Large Pizza', priceCents: 1900 },
      select: { id: true },
    });
    const group = await prisma.modifierGroup.create({
      data: { menuItemId: pizza.id, name: 'Toppings', selectionType: 'multi', allowsHalves: false },
    });
    pizzaGroupId = group.id;
    await prisma.modifier.create({ data: { modifierGroupId: group.id, name: 'Pepperoni', priceCents: 150 } });
    const calzone = await prisma.menuItem.create({
      data: {
        categoryId: cat.id,
        name: 'Calzone',
        priceCents: 1150,
        description: 'Stuffed with pizza toppings of your choice - toppings $1 each',
      },
      select: { id: true },
    });
    calzoneId = calzone.id;

    // An item on the other location, to prove a proposal cannot reach it.
    const otherMenu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId: otherLocationId, name: 'Other Menu', active: true },
      select: { id: true },
    });
    const otherCat = await prisma.menuCategory.create({ data: { menuId: otherMenu.id, name: 'Subs' }, select: { id: true } });
    otherItemId = (await prisma.menuItem.create({
      data: { categoryId: otherCat.id, name: 'Meatball Sub', priceCents: 1200 },
      select: { id: true },
    })).id;

    const call = await prisma.call.create({
      data: {
        tenantId: SEEDED_TENANT,
        locationId,
        provider: 'twilio',
        fromNumber: '+15185552020',
        status: 'completed',
        startedAt: new Date(Date.now() - 60 * 60 * 1000),
        endedAt: new Date(Date.now() - 59 * 60 * 1000),
        summary: 'Ordered a calzone with sausage.',
        transcript: {
          create: {
            turns: [
              { speaker: 'agent', text: 'Thanks for calling. How can I help?' },
              { speaker: 'caller', text: 'A calzone with sausage please.' },
            ],
          },
        },
      },
      select: { id: true },
    });
    callIds.push(call.id);
  });

  beforeEach(() => {
    // The script is indexed by request count, so each case starts it over.
    llm.requests = [];
    llm.script = [];
  });

  afterAll(async () => {
    for (const id of callIds) await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { action: 'assistant.chat', targetId: locationId } }).catch(() => {});
    for (const id of [locationId, otherLocationId]) await prisma.location.deleteMany({ where: { id } }).catch(() => {});
    for (const id of userIds) {
      await prisma.userTenantMembership.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    }
    await app.close();
    await unconfigured.close();
    await prisma.$disconnect();
  });

  it('is for managers and owners', async () => {
    const res = await chat([{ role: 'user', content: 'hi' }], STAFF_EMAIL);
    expect(res.statusCode).toBe(403);
  });

  it('says so when no model is configured', async () => {
    const res = await unconfigured.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/assistant/chat`,
      headers: headersFor(OWNER_EMAIL),
      payload: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('assistant_not_configured');
  });

  it('reads the menu health, a call, and turns a fix into a proposal the owner can apply', async () => {
    llm.script = [
      { tools: [{ name: 'get_menu_health' }, { name: 'list_recent_calls', arguments: { limit: 5 } }] },
      { tools: [{ name: 'get_call', arguments: { call_id: callIds[0] } }] },
      {
        text: 'The calzone promises toppings but has none set up, which is why the sausage went to free text.',
        tools: [
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Give the Calzone a Toppings group',
              reason: 'Its description says toppings $1 each; a caller asked for sausage an hour ago.',
              fix: {
                kind: 'create_group',
                item_id: calzoneId,
                name: 'Toppings',
                selection_type: 'multi',
                required: false,
                modifiers: [{ name: 'Sausage', price_cents: 100 }],
              },
            },
          },
        ],
      },
      { text: 'I have put that up as a proposal — apply it and the next caller’s sausage gets priced.' },
    ];
    llm.requests = [];
    const res = await chat([{ role: 'user', content: 'Why did the calzone order go wrong?' }]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { reply: string; proposals: Array<{ summary: string; fix: Record<string, unknown> }>; toolsUsed: string[] };
    expect(body.reply).toContain('proposal');
    expect(body.toolsUsed).toEqual(['get_menu_health', 'list_recent_calls', 'get_call', 'propose_edit']);
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0]!.summary).toBe('Give the Calzone a Toppings group');
    // Snake case from the model became the fix shape the dashboard applies.
    expect(body.proposals[0]!.fix).toMatchObject({
      kind: 'create_group',
      itemId: calzoneId,
      selectionType: 'multi',
      modifiers: [{ name: 'Sausage', priceCents: 100 }],
    });

    // What the model was shown along the way: a real finding, the real call.
    const second = llm.requests[1]!.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(second[0]).toContain('options_promised_no_group');
    expect(second[1]).toContain(callIds[0]);
    const third = llm.requests[2]!.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(third.at(-1)).toContain('Caller: A calzone with sausage please.');
    // The system prompt names the restaurant and the rules.
    expect(llm.requests[0]![0]).toMatchObject({ role: 'system' });
    expect(llm.requests[0]![0]!.content).toContain('Assistant Kitchen');
    expect(llm.requests[0]![0]!.content).toContain('Never state a price');

    // On the record.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'assistant.chat', targetId: locationId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({
      tools: ['get_menu_health', 'list_recent_calls', 'get_call', 'propose_edit'],
      proposals: [{ kind: 'create_group', summary: 'Give the Calzone a Toppings group' }],
    });
  });

  it('refuses a proposal aimed at another location’s menu, and a malformed one', async () => {
    llm.script = [
      {
        tools: [
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Raise the meatball sub',
              reason: 'because',
              fix: { kind: 'update_item', item_id: otherItemId, price_cents: 1300 },
            },
          },
          {
            name: 'propose_edit',
            arguments: { summary: 'Do a thing', reason: 'because', fix: { kind: 'delete_everything' } },
          },
        ],
      },
      { text: 'Neither of those could be recorded.' },
    ];
    llm.requests = [];
    const res = await chat([{ role: 'user', content: 'raise it' }]);
    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toEqual([]);
    const results = llm.lastToolResults();
    expect(results[0]).toMatch(/not on this location/);
    expect(results[1]).toMatch(/Not recorded/);
  });

  it('records a halves switch and a price change against ids on this menu', async () => {
    llm.script = [
      {
        text: 'Two edits.',
        tools: [
          {
            name: 'propose_edit',
            arguments: { summary: 'Allow halves', reason: 'pizza', fix: { kind: 'allow_halves', group_id: pizzaGroupId } },
          },
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Calzone to $12',
              reason: 'owner asked',
              fix: { kind: 'update_item', item_id: calzoneId, price_cents: 1200 },
            },
          },
        ],
      },
      { text: 'Both are up as proposals.' },
    ];
    const res = await chat([{ role: 'user', content: 'allow halves and make the calzone twelve dollars' }]);
    const proposals = res.json().proposals as Array<{ fix: Record<string, unknown> }>;
    expect(proposals.map((p) => p.fix)).toEqual([
      { kind: 'allow_halves', groupId: pizzaGroupId },
      { kind: 'update_item', itemId: calzoneId, priceCents: 1200 },
    ]);
  });

  it('reads the template that fits this menu and says which of its sections are already there', async () => {
    llm.script = [{ tools: [{ name: 'get_menu_template' }] }, { text: 'Read it.' }];
    const res = await chat([{ role: 'user', content: 'what am I missing?' }]);
    expect(res.statusCode).toBe(200);
    const shown = JSON.parse(llm.lastToolResults()[0]!) as {
      template_id: string;
      sections: Array<{ name: string; on_menu: boolean; starter_items: Array<{ name: string; groups: string[] }> }>;
      groups: Array<{ name: string; options: Array<{ name: string; price_cents: number }> }>;
    };
    // A menu of pizza and a calzone reads as a pizzeria, not a deli.
    expect(shown.template_id).toBe('pizzeria');
    expect(shown.sections.find((c) => c.name === 'Pizza')?.on_menu).toBe(true);
    const wings = shown.sections.find((c) => c.name === 'Wings');
    expect(wings?.on_menu).toBe(false);
    expect(wings?.starter_items[0]?.groups).toEqual(['Sauce', 'Dip']);
    expect(shown.groups.find((g) => g.name === 'Sauce')?.options.length).toBeGreaterThan(3);
  });

  it('builds an item from the template: the rules pick its groups, and no price means hidden until priced', async () => {
    llm.script = [
      {
        text: 'Two items.',
        tools: [
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Add Wings (10) under Wings',
              reason: 'The template has a Wings section and the menu has none.',
              fix: { kind: 'create_item', category: 'Wings', name: 'Wings (10)', template_id: 'pizzeria' },
            },
          },
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Add a Small Cheese Pizza at $12',
              reason: 'The owner said twelve dollars.',
              fix: { kind: 'create_item', category: 'Pizza', name: 'Small Cheese Pizza', price_cents: 1200 },
            },
          },
        ],
      },
      { text: 'Both are up as proposals; the wings are hidden until you price them.' },
    ];
    const res = await chat([{ role: 'user', content: 'add wings, and a small cheese pizza for twelve dollars' }]);
    expect(res.statusCode).toBe(200);
    const proposals = res.json().proposals as Array<{ fix: Record<string, unknown> & { groups: Array<Record<string, unknown>> } }>;
    expect(proposals).toHaveLength(2);
    const [wings, pizza] = proposals.map((p) => p.fix);
    expect(wings).toMatchObject({ kind: 'create_item', category: 'Wings', name: 'Wings (10)' });
    expect(wings!.priceCents).toBeUndefined();
    expect(wings!.templateId).toBeUndefined();
    expect(wings!.groups.map((g) => g.name)).toEqual(['Sauce', 'Dip']);
    expect(wings!.groups[0]).toMatchObject({ selectionType: 'single', required: true, allowsHalves: false });
    expect((wings!.groups[0]!.modifiers as unknown[]).length).toBeGreaterThan(3);
    // The pizza's groups follow the pizza rules: small-pizza toppings, halves on.
    expect(pizza).toMatchObject({ kind: 'create_item', priceCents: 1200 });
    expect(pizza!.groups.map((g) => g.name)).toEqual(['Toppings']);
    expect(pizza!.groups[0]!.allowsHalves).toBe(true);
    expect(pizza!.groups[0]!.modifiers).toContainEqual({ name: 'Pepperoni', priceCents: 150 });
  });

  it('keeps the groups the model gave instead of the template’s', async () => {
    llm.script = [
      {
        tools: [
          {
            name: 'propose_edit',
            arguments: {
              summary: 'Add a Side Salad',
              reason: 'asked',
              fix: {
                kind: 'create_item',
                category: 'Salads',
                name: 'Side Salad',
                groups: [{ name: 'Dressing', selection_type: 'single', required: true, modifiers: [{ name: 'Ranch', price_cents: 0 }] }],
              },
            },
          },
        ],
      },
      { text: 'Up.' },
    ];
    const res = await chat([{ role: 'user', content: 'add a side salad with ranch only' }]);
    const fix = res.json().proposals[0].fix as { groups: Array<{ name: string; modifiers: unknown[] }> };
    expect(fix.groups).toEqual([{ name: 'Dressing', selectionType: 'single', required: true, modifiers: [{ name: 'Ranch', priceCents: 0 }] }]);
  });

  it('refuses a section or an item the menu already has, and records one it lacks', async () => {
    llm.script = [
      {
        tools: [
          { name: 'propose_edit', arguments: { summary: 'Add Pizza', reason: 'x', fix: { kind: 'create_category', name: 'pizza' } } },
          { name: 'propose_edit', arguments: { summary: 'Add Calzone', reason: 'x', fix: { kind: 'create_item', category: 'Pizza', name: 'calzone' } } },
          { name: 'propose_edit', arguments: { summary: 'Add Desserts', reason: 'x', fix: { kind: 'create_category', name: 'Desserts' } } },
        ],
      },
      { text: 'One of three.' },
    ];
    const res = await chat([{ role: 'user', content: 'add pizza, calzone, desserts' }]);
    expect(res.statusCode).toBe(200);
    const results = llm.lastToolResults();
    expect(results[0]).toMatch(/already has a "pizza" section/);
    expect(results[1]).toMatch(/already has "Calzone"/);
    expect(results[2]).toMatch(/Recorded as a proposal/);
    expect(res.json().proposals.map((p: { fix: unknown }) => p.fix)).toEqual([{ kind: 'create_category', name: 'Desserts' }]);
  });

  it('stops after its pass budget when the model keeps calling tools', async () => {
    llm.script = Array.from({ length: 10 }, () => ({ tools: [{ name: 'get_menu_gaps' }] }));
    llm.requests = [];
    const res = await chat([{ role: 'user', content: 'loop forever' }]);
    expect(res.statusCode).toBe(200);
    expect(llm.requests.length).toBe(6);
    expect(res.json().reply).toMatch(/ran out of steps/);
  });

  it('insists the thread ends with the user', async () => {
    const res = await chat([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('bad_thread');
  });

  it('is scoped: another tenant’s location is not found', async () => {
    const outsider = await prisma.tenant.create({ data: { name: 'Outsider Pizza' }, select: { id: true } });
    const loc = await prisma.location.create({ data: { tenantId: outsider.id, name: 'Elsewhere' }, select: { id: true } });
    const res = await chat([{ role: 'user', content: 'hi' }], OWNER_EMAIL, loc.id);
    expect(res.statusCode).toBe(404);
    await prisma.tenant.deleteMany({ where: { id: outsider.id } }).catch(() => {});
  });
});
