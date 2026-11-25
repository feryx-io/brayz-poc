import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file, with its own location so its call count is its own.
const TEST_NUMBER = '+15185550147';
const REGULAR = '+15185550947';

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
const GREETINGS = ['Line one, {staff_name} here.', 'Line two, {staff_name} here.', 'Line three, {staff_name} here.'];
const WELCOMES = ['Welcome back, {guest_name}!', 'Hey {guest_name}!'];

describe.skipIf(!dbUp)('Greeting rotation (which line a call gets)', () => {
  let app: App;
  let locationId: string;
  let guestId: string;

  async function profileFor(fromNumber: string, guest?: string) {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber, toNumber: TEST_NUMBER },
    });
    const callId = created.json().id as string;
    // The call-create route only links a guest it already knows by number;
    // the regular here is linked the way a recognized caller's call is.
    if (guest) await prisma.call.update({ where: { id: callId }, data: { guestId: guest } });
    const res = await app.inject({ method: 'GET', url: `/v1/calls/${callId}/tools/profile`, headers: nodeHeaders });
    expect(res.statusCode).toBe(200);
    return res.json() as { greeting: string | null; welcomeBack: string };
  }

  beforeAll(async () => {
    app = await buildApp();
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Rotation Kitchen', aiGreetings: GREETINGS, welcomeBackLines: WELCOMES },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({ data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER } });
    const guest = await prisma.guest.create({
      data: { tenantId: SEEDED_TENANT, locationId, displayName: 'Dana' },
      select: { id: true },
    });
    guestId = guest.id;
  });

  afterAll(async () => {
    await prisma.location.delete({ where: { id: locationId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('a regular hears the next line each call, wrapping around', async () => {
    const heard: string[] = [];
    const welcomed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await profileFor(REGULAR, guestId);
      heard.push(p.greeting!);
      welcomed.push(p.welcomeBack);
    }
    expect(heard).toEqual([GREETINGS[0], GREETINGS[1], GREETINGS[2], GREETINGS[0]]);
    expect(welcomed).toEqual([WELCOMES[0], WELCOMES[1], WELCOMES[0], WELCOMES[1]]);
  });

  it('a stranger gets one of the lines, never something else', async () => {
    for (let i = 0; i < 5; i++) {
      const p = await profileFor('+15185550999');
      expect(GREETINGS).toContain(p.greeting);
      expect(WELCOMES).toContain(p.welcomeBack);
    }
  });

  it('with nothing written, there is no greeting and a built-in welcome line', async () => {
    await prisma.location.update({ where: { id: locationId }, data: { aiGreetings: [], welcomeBackLines: [] } });
    const p = await profileFor('+15185550998');
    expect(p.greeting).toBeNull();
    expect(p.welcomeBack).toContain('{guest_name}');
  });
});
