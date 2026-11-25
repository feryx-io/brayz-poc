import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file, with its own location so ai-settings writes race nobody.
const TEST_NUMBER = '+15185550146';
const OWNER_EMAIL = `voices-owner-${Date.now()}@brayz.test`;
const STAFF_EMAIL = `voices-staff-${Date.now()}@brayz.test`;

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
const headersFor = (email: string) => ({
  'x-brayz-user-email': email,
  'x-brayz-tenant-id': SEEDED_TENANT,
  'content-type': 'application/json',
});

/** A TTS provider with a two-voice catalog that "speaks" 100 ms of silence. */
function fakeTts() {
  const spoken: Array<{ text: string; voiceId?: string; sampleRate: number }> = [];
  let catalogCalls = 0;
  return {
    spoken,
    calls: () => catalogCalls,
    provider: {
      name: 'fake-tts',
      async listVoices() {
        catalogCalls += 1;
        return [
          { id: 'v-apollo', name: 'Apollo', language: 'en', accent: 'American', age: 'Adult', tags: ['masculine'] },
          { id: 'v-thalia', name: 'Thalia', language: 'en', accent: 'American', age: 'Adult', tags: ['feminine'] },
        ];
      },
      async synthesize(opts: { text: string; voiceId?: string; sampleRate: number; onAudio: (f: Uint8Array) => void }) {
        spoken.push({ text: opts.text, voiceId: opts.voiceId, sampleRate: opts.sampleRate });
        const frame = Math.round((opts.sampleRate * 20) / 1000) * 2;
        for (let i = 0; i < 5; i++) opts.onAudio(new Uint8Array(frame));
      },
    },
  };
}

describe.skipIf(!dbUp)('Default AI voice: catalog, preview, and what answers the call', () => {
  let app: App;
  let locationId: string;
  const userIds: string[] = [];
  const tts = fakeTts();

  beforeAll(async () => {
    app = await buildApp({ tts: tts.provider });
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Voice Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({ data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER } });
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [STAFF_EMAIL, 'staff'],
    ] as const) {
      const user = await prisma.user.create({ data: { email, authSubject: email } });
      userIds.push(user.id);
      await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId: user.id, role } });
    }
  });

  afterAll(async () => {
    await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('lists the provider voices, and asks the provider once', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/voices', headers: headersFor(STAFF_EMAIL) });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: 'fake-tts' });
    expect(first.json().voices.map((v: { id: string }) => v.id)).toEqual(['v-apollo', 'v-thalia']);
    await app.inject({ method: 'GET', url: '/v1/voices', headers: headersFor(OWNER_EMAIL) });
    expect(tts.calls()).toBe(1);
  });

  it('refuses without a tenant', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/voices' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('previews a line in a voice as playable WAV (manager+)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/voices/preview`,
      headers: headersFor(OWNER_EMAIL),
      payload: { voiceId: 'v-apollo', text: 'Thanks for calling. This is Sam.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/wav');
    const wav = res.rawPayload;
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.subarray(8, 12).toString()).toBe('WAVE');
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate in the header matches what was synthesized
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44); // data chunk length is the PCM that followed
    expect(tts.spoken.at(-1)).toMatchObject({ text: 'Thanks for calling. This is Sam.', voiceId: 'v-apollo', sampleRate: 24_000 });
  });

  it('a staff member cannot preview (it costs money)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/voices/preview`,
      headers: headersFor(STAFF_EMAIL),
      payload: { voiceId: 'v-apollo', text: 'hi' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an over-long or empty line', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/voices/preview`,
      headers: headersFor(OWNER_EMAIL),
      payload: { voiceId: 'v-apollo', text: 'x'.repeat(301) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('the chosen default voice and name answer the call when no staff voice does', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: headersFor(OWNER_EMAIL),
      payload: { voiceMode: 'default', defaultVoiceId: 'v-thalia', assistantName: 'Sam' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ defaultVoiceId: 'v-thalia', assistantName: 'Sam' });

    const call = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', toNumber: TEST_NUMBER },
    });
    const voice = await app.inject({
      method: 'GET',
      url: `/v1/calls/${call.json().id}/tools/voice`,
      headers: nodeHeaders,
    });
    expect(voice.json()).toMatchObject({ voiceId: 'v-thalia', staffName: 'Sam' });

    // Clearing the voice keeps the name: the provider default then answers as Sam.
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/ai-settings`,
      headers: headersFor(OWNER_EMAIL),
      payload: { defaultVoiceId: null },
    });
    const again = await app.inject({
      method: 'GET',
      url: `/v1/calls/${call.json().id}/tools/voice`,
      headers: nodeHeaders,
    });
    expect(again.json()).toMatchObject({ voiceId: null, staffName: 'Sam' });
  });
});

describe.skipIf(!dbUp)('Default AI voice without a speech provider', () => {
  it('has an empty catalog and refuses previews rather than faking them', async () => {
    const app = await buildApp({ tts: null });
    const user = await prisma.user.create({
      data: { email: `voices-none-${Date.now()}@brayz.test`, authSubject: `voices-none-${Date.now()}` },
    });
    await prisma.userTenantMembership.create({ data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' } });
    const location = await prisma.location.create({ data: { tenantId: SEEDED_TENANT, name: 'No TTS' }, select: { id: true } });
    try {
      const list = await app.inject({ method: 'GET', url: '/v1/voices', headers: headersFor(user.email) });
      expect(list.json()).toEqual({ provider: null, voices: [] });
      const res = await app.inject({
        method: 'POST',
        url: `/v1/locations/${location.id}/voices/preview`,
        headers: headersFor(user.email),
        payload: { voiceId: 'v-apollo', text: 'hi' },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      await prisma.location.delete({ where: { id: location.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
      await app.close();
    }
  });
});
