import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file: staff owns 0129 — and its OWN location, so its
// ai-settings writes never race the guests/loyalty files.
const TEST_NUMBER = '+15185550129';
const OWNER_EMAIL = `staff-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const nodeHeaders = { 'x-brayz-node-secret': NODE_SECRET, 'content-type': 'application/json' };
const ownerHeaders = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
};

describe.skipIf(!dbUp)('Staff voices (consent-gated cloning + rotation + call voice)', () => {
  let app: App;
  let locationId: string;
  let userId: string | undefined;
  let staffId: string;
  let voiceProfileId: string;
  let samId: string;

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', toNumber: TEST_NUMBER },
    });
    return res.json().id;
  }

  async function callVoice() {
    const callId = await newCall();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/tools/voice`,
      headers: nodeHeaders,
    });
    return res.json();
  }

  beforeAll(async () => {
    app = await buildApp({
      voiceCloner: {
        name: 'test-clone',
        createVoice: async ({ label }) => ({ voiceId: `test-voice-${label.toLowerCase()}` }),
      },
      tts: {
        name: 'fake-tts',
        async listVoices() {
          return [{ id: 'v-apollo', name: 'Apollo', language: 'en', tags: ['masculine'] }];
        },
        async synthesize() {},
      },
    });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Staff Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });
    const user = await prisma.user.create({ data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL } });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    await prisma.call.deleteMany({ where: { toNumber: TEST_NUMBER } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    // Staff, voices, and consent records cascade with the location.
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('creates and lists staff with no consent on record', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/staff`,
      headers: ownerHeaders,
      payload: { name: 'Tony', role: 'Manager' },
    });
    expect(create.statusCode).toBe(201);
    staffId = create.json().id;

    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/staff`,
      headers: ownerHeaders,
    });
    expect(list.json()).toMatchObject([
      { name: 'Tony', role: 'Manager', consent: null, voiceProfiles: [] },
    ]);
  });

  it('refuses to clone a voice without recorded consent (rule #6, in code)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/staff/${staffId}/voice`,
      headers: ownerHeaders,
      payload: { label: 'Front desk' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('consent_required');
  });

  it('records a consent grant (audited, with source + who recorded it)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/staff/${staffId}/consent`,
      headers: ownerHeaders,
      payload: { action: 'granted', source: 'paper', notes: 'Signed form on file' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ action: 'granted', source: 'paper' });
    expect(res.json().recordedByUserId).toBe(userId);

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: staffId, action: 'voice.consent.granted' },
    });
    expect(audit).toBeTruthy();
    expect((audit!.metadata as { source?: string }).source).toBe('paper');
  });

  it('clones a voice after consent and can put it in the rotation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/staff/${staffId}/voice`,
      headers: ownerHeaders,
      payload: { label: 'Front desk' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'ready',
      provider: 'test-clone',
      providerVoiceId: 'test-voice-front desk',
    });
    voiceProfileId = res.json().id;

    const rotate = await app.inject({
      method: 'PATCH',
      url: `/v1/voice-profiles/${voiceProfileId}`,
      headers: ownerHeaders,
      payload: { enabledForRotation: true },
    });
    expect(rotate.json().enabledForRotation).toBe(true);
  });

  it('serves the default voice until a mode is chosen, then the fixed staff voice', async () => {
    expect(await callVoice()).toMatchObject({ voiceId: null });

    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { voiceMode: 'fixed', fixedVoiceProfileId: voiceProfileId },
    });
    expect(await callVoice()).toMatchObject({
      voiceId: 'test-voice-front desk',
      staffName: 'Tony',
    });
  });

  it('rotate mode serves a rotation-enabled voice', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { voiceMode: 'rotate' },
    });
    expect(await callVoice()).toMatchObject({
      voiceId: 'test-voice-front desk',
      staffName: 'Tony',
    });
  });

  it('revoking consent retires the voice everywhere, immediately (audited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/staff/${staffId}/consent`,
      headers: ownerHeaders,
      payload: { action: 'revoked', source: 'dashboard' },
    });
    expect(res.statusCode).toBe(201);

    const profile = await prisma.staffVoiceProfile.findUnique({ where: { id: voiceProfileId } });
    expect(profile).toMatchObject({ status: 'revoked', enabledForRotation: false });

    // The call-time resolver refuses the revoked voice in every mode.
    expect(await callVoice()).toMatchObject({ voiceId: null });
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { voiceMode: 'fixed', fixedVoiceProfileId: voiceProfileId },
    });
    expect(await callVoice()).toMatchObject({ voiceId: null });

    // And new cloning is blocked again.
    const clone = await app.inject({
      method: 'POST',
      url: `/v1/staff/${staffId}/voice`,
      headers: ownerHeaders,
      payload: { label: 'Second try' },
    });
    expect(clone.statusCode).toBe(422);

    const audit = await prisma.auditLog.findFirst({
      where: { targetId: staffId, action: 'voice.consent.revoked' },
    });
    expect(audit).toBeTruthy();
  });

  it('keeps the full consent ledger (append-only, both records)', async () => {
    const records = await prisma.voiceConsentRecord.findMany({
      where: { staffProfileId: staffId },
      orderBy: { createdAt: 'asc' },
    });
    expect(records.map((r) => r.action)).toEqual(['granted', 'revoked']);
  });

  it('deletes a staff member (voices + consent cascade)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/staff/${staffId}`,
      // No content-type: a DELETE has no body to parse.
      headers: { 'x-brayz-user-email': OWNER_EMAIL, 'x-brayz-tenant-id': SEEDED_TENANT },
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.staffVoiceProfile.count({ where: { staffProfileId: staffId } })).toBe(0);
    expect(await prisma.voiceConsentRecord.count({ where: { staffProfileId: staffId } })).toBe(0);
  });

  it('a persona can be given a catalog voice at creation, with no consent involved', async () => {
    const create = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/staff`,
      headers: ownerHeaders,
      payload: { name: 'Sam', role: 'Front desk', providerVoiceId: 'v-apollo' },
    });
    expect(create.statusCode).toBe(201);
    samId = create.json().id;
    const list = await app.inject({ method: 'GET', url: `/v1/locations/${locationId}/staff`, headers: ownerHeaders });
    const sam = (list.json() as Array<{ name: string; consent: unknown; voiceProfiles: Array<Record<string, unknown>> }>).find(
      (s) => s.name === 'Sam',
    )!;
    expect(sam.consent).toBeNull();
    expect(sam.voiceProfiles).toEqual([
      expect.objectContaining({ label: 'Apollo', status: 'ready', source: 'provider', providerVoiceId: 'v-apollo' }),
    ]);

    // Fixed mode serves it, under the persona's name.
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { voiceMode: 'fixed', fixedVoiceProfileId: sam.voiceProfiles[0]!.id },
    });
    expect(await callVoice()).toMatchObject({ voiceId: 'v-apollo', staffName: 'Sam' });

    // Revoking consent (there was none to begin with) does not touch a catalog voice.
    await app.inject({
      method: 'POST',
      url: `/v1/staff/${create.json().id}/consent`,
      headers: ownerHeaders,
      payload: { action: 'revoked', source: 'dashboard' },
    });
    expect(await callVoice()).toMatchObject({ voiceId: 'v-apollo', staffName: 'Sam' });
  });

  it('an existing persona can be given a catalog voice; an unknown voice id is refused and creates nothing', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/staff`,
      headers: ownerHeaders,
      payload: { name: 'Nobody', providerVoiceId: 'v-nope' },
    });
    expect(bad.statusCode).toBe(422);
    expect(await prisma.staffProfile.count({ where: { locationId, name: 'Nobody' } })).toBe(0);

    const assign = await app.inject({
      method: 'POST',
      url: `/v1/staff/${samId}/voice/provider`,
      headers: ownerHeaders,
      payload: { voiceId: 'v-apollo', label: 'Weekend voice' },
    });
    expect(assign.statusCode).toBe(201);
    expect(assign.json()).toMatchObject({ label: 'Weekend voice', status: 'ready', source: 'provider' });

    // Sam already had a catalog voice: this replaced it in place rather than adding a second.
    const profiles = await prisma.staffVoiceProfile.findMany({ where: { staffProfileId: samId, source: 'provider' } });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ id: assign.json().id, label: 'Weekend voice', providerVoiceId: 'v-apollo' });
  });

  it('per-call rotation is a round robin: a new voice each call, wrapping around', async () => {
    await prisma.staffVoiceProfile.updateMany({ where: { staff: { locationId } }, data: { enabledForRotation: false } });
    for (const name of ['Ava', 'Ben']) {
      const created = await app.inject({
        method: 'POST',
        url: `/v1/locations/${locationId}/staff`,
        headers: ownerHeaders,
        payload: { name, providerVoiceId: 'v-apollo' },
      });
      const voice = await prisma.staffVoiceProfile.findFirst({ where: { staffProfileId: created.json().id } });
      await prisma.staffVoiceProfile.update({ where: { id: voice!.id }, data: { enabledForRotation: true } });
    }
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { voiceMode: 'rotate', voiceRotation: 'per_call' },
    });
    const names: string[] = [];
    for (let i = 0; i < 4; i++) names.push((await callVoice()).staffName);
    // Two voices in the pool: consecutive calls alternate, whichever one the sequence starts on.
    expect(new Set(names.slice(0, 2)).size).toBe(2);
    expect(names[2]).toBe(names[0]);
    expect(names[3]).toBe(names[1]);
  });

  it('callers may ask for a persona by name only when the location allows it', async () => {
    const callId = await newCall();
    const off = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/personas`, headers: nodeHeaders });
    expect(off.json()).toEqual({ enabled: false, personas: [] });
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/persona`,
      headers: nodeHeaders,
      payload: { name: 'Ben' },
    });
    expect(refused.statusCode).toBe(409);

    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: ownerHeaders,
      payload: { personaSwitchEnabled: true },
    });
    const on = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/personas`, headers: nodeHeaders });
    expect(on.json().enabled).toBe(true);
    // Only people with a ready voice are offered — Tony's clone was revoked.
    const names = on.json().personas.map((p: { name: string }) => p.name);
    expect(names).toEqual(expect.arrayContaining(['Sam', 'Ava', 'Ben']));
    expect(names).not.toContain('Tony');
    // Never the voice ids: those come back only on the switch itself.
    expect(JSON.stringify(on.json())).not.toContain('v-apollo');

    const switched = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/persona`,
      headers: nodeHeaders,
      payload: { name: 'ben' },
    });
    expect(switched.statusCode).toBe(200);
    expect(switched.json()).toEqual({ voiceId: 'v-apollo', staffName: 'Ben' });
    const event = await prisma.callEvent.findFirst({ where: { callId, eventType: 'call.persona_switched' } });
    expect(event?.payload).toMatchObject({ staffName: 'Ben' });

    const nobody = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/tools/persona`,
      headers: nodeHeaders,
      payload: { name: 'Maria' },
    });
    expect(nobody.statusCode).toBe(404);
  });
});
