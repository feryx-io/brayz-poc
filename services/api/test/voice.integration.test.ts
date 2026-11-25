import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
// BRAYZ_NODE_SHARED_SECRET defaults to 'dev-only-change-me'.

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const SEEDED_LOCATION = '00000000-0000-0000-0000-0000000000b1';
const NODE_SECRET = 'dev-only-change-me';
const TEST_NUMBER = '+15185550123';
const NODE_ID = `siphon-test-${Date.now()}`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET };
const userHeaders = { 'x-brayz-tenant-id': SEEDED_TENANT };

describe.skipIf(!dbUp)('Phase 2 voice plane', () => {
  let app: App;
  const createdCallIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    // Provision a phone number on the seeded location so calls can resolve.
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, e164Number: TEST_NUMBER },
    });
  });

  afterAll(async () => {
    await prisma.call.deleteMany({ where: { id: { in: createdCallIds } } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    await prisma.voiceNode.deleteMany({ where: { nodeId: NODE_ID } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects node endpoints without the node secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice-nodes/register',
      payload: { nodeId: NODE_ID, region: 'us-east4', environment: 'dev' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('registers, heartbeats, drains, and undrains a node', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/voice-nodes/register',
      headers: nodeHeaders,
      payload: { nodeId: NODE_ID, region: 'us-east4', environment: 'dev', maxCalls: 50 },
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json()).toMatchObject({ nodeId: NODE_ID, status: 'ready', maxCalls: 50 });

    const hb = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/heartbeat`,
      headers: nodeHeaders,
      payload: { activeCalls: 3 },
    });
    expect(hb.json()).toMatchObject({ ok: true });

    const drain = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/drain`,
      headers: nodeHeaders,
    });
    expect(drain.json()).toMatchObject({ status: 'draining' });

    // A draining node stays draining even if it heartbeats as ready.
    const hb2 = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/heartbeat`,
      headers: nodeHeaders,
      payload: { activeCalls: 1, status: 'ready' },
    });
    expect(hb2.json()).toMatchObject({ status: 'draining' });

    const undrain = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/undrain`,
      headers: nodeHeaders,
    });
    expect(undrain.json()).toMatchObject({ status: 'ready' });
  });

  it('keeps the latest health snapshot a node reports, and refuses a malformed one', async () => {
    const health = {
      version: '0.51.1',
      serviceActive: true,
      live: true,
      ready: true,
      uptimeSeconds: 3911,
      dialogsActive: 0,
      rtpPortPairsAllocated: 0,
      rtpPortPairsCapacity: 5000,
      hepCollectorUp: true,
      webhookSpoolDepth: null,
      recordingSpoolDepth: 0,
      load1: 0.03,
      cpus: 2,
      memUsedPct: 23.9,
      diskUsedPct: 15,
    };
    const hb = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/heartbeat`,
      headers: nodeHeaders,
      // The exact shape brayz-node-heartbeat sends, publicIp null included.
      payload: { activeCalls: 0, publicIp: null, health },
    });
    expect(hb.statusCode).toBe(200);
    const row = await prisma.voiceNode.findUnique({ where: { nodeId: NODE_ID } });
    expect(row?.health).toEqual(health);

    const bad = await app.inject({
      method: 'POST',
      url: `/v1/voice-nodes/${NODE_ID}/heartbeat`,
      headers: nodeHeaders,
      payload: { activeCalls: 0, health: { ...health, memUsedPct: 140 } },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('ingests a call, advances status via events, and shows it on the dashboard', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551331', toNumber: TEST_NUMBER, nodeId: NODE_ID },
    });
    expect(create.statusCode).toBe(201);
    const call = create.json();
    createdCallIds.push(call.id);
    expect(call).toMatchObject({ tenantId: SEEDED_TENANT, locationId: SEEDED_LOCATION, status: 'started' });

    await app.inject({
      method: 'POST',
      url: `/v1/calls/${call.id}/events`,
      headers: nodeHeaders,
      payload: { eventType: 'call.answered' },
    });
    await app.inject({
      method: 'POST',
      url: `/v1/calls/${call.id}/events`,
      headers: nodeHeaders,
      payload: { eventType: 'call.completed' },
    });

    const detail = await app.inject({ method: 'GET', url: `/v1/calls/${call.id}`, headers: userHeaders });
    expect(detail.json().status).toBe('completed');
    expect((detail.json().events as Array<{ eventType: string }>).map((e) => e.eventType)).toEqual([
      'call.answered',
      'call.completed',
    ]);

    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${SEEDED_LOCATION}/calls`,
      headers: userHeaders,
    });
    expect((list.json().calls as Array<{ id: string }>).some((c) => c.id === call.id)).toBe(true);
  });

  it('rejects a call to an unprovisioned number', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { toNumber: '+15180000000' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('number_not_provisioned');
  });

  it('records a normalized Twilio status webhook against the call', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', providerCallId: `CA${Date.now()}`, toNumber: TEST_NUMBER },
    });
    const call = create.json();
    createdCallIds.push(call.id);
    const providerCallId = (await prisma.call.findUnique({ where: { id: call.id } }))!.providerCallId!;

    const hook = await app.inject({
      method: 'POST',
      url: '/v1/carriers/twilio/status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `CallSid=${providerCallId}&CallStatus=completed&From=%2B15185551331&To=${encodeURIComponent(TEST_NUMBER)}`,
    });
    expect(hook.statusCode).toBe(204);

    const events = await prisma.callEvent.findMany({ where: { callId: call.id } });
    expect(events.map((e) => e.eventType)).toContain('call.completed');
  });
  it('appends transcript turns and reads them back in order', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551331', toNumber: TEST_NUMBER },
    });
    const call = create.json();
    createdCallIds.push(call.id);

    // The voice plane appends as the conversation happens — two separate writes,
    // so the append (not overwrite) path is what's under test.
    const first = await app.inject({
      method: 'POST',
      url: `/v1/calls/${call.id}/transcript/turns`,
      headers: nodeHeaders,
      payload: { turns: [{ speaker: 'agent', text: 'Thanks for calling. How can I help?' }] },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ ok: true, appended: 1 });

    await app.inject({
      method: 'POST',
      url: `/v1/calls/${call.id}/transcript/turns`,
      headers: nodeHeaders,
      payload: {
        turns: [
          { speaker: 'caller', text: 'What time do you close?', confidence: 0.94 },
          { speaker: 'agent', text: 'We close at ten tonight.' },
        ],
      },
    });

    const read = await app.inject({
      method: 'GET',
      url: `/v1/calls/${call.id}/transcript`,
      headers: userHeaders,
    });
    expect(read.statusCode).toBe(200);
    const turns = read.json().turns as Array<{ speaker: string; text: string; at?: string }>;
    expect(turns.map((t) => t.speaker)).toEqual(['agent', 'caller', 'agent']);
    expect(turns[1].text).toBe('What time do you close?');
    // Every turn is stamped even when the caller doesn't send one.
    expect(turns.every((t) => typeof t.at === 'string')).toBe(true);
  });

  it('refuses transcript writes without the node secret, and 404s an unknown call', async () => {
    const unauthed = await app.inject({
      method: 'POST',
      url: `/v1/calls/${createdCallIds[0]}/transcript/turns`,
      payload: { turns: [{ speaker: 'agent', text: 'nope' }] },
    });
    expect(unauthed.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'POST',
      url: '/v1/calls/00000000-0000-0000-0000-0000000000ff/transcript/turns',
      headers: nodeHeaders,
      payload: { turns: [{ speaker: 'agent', text: 'nope' }] },
    });
    expect(missing.statusCode).toBe(404);
  });
});
