import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Dev-mode account registration + profile, against the live Docker DB.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
type App = Awaited<ReturnType<typeof buildApp>>;

let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch {
  dbUp = false;
}

const EMAIL = `acct-${Date.now()}@brayz.test`;

describe.skipIf(!dbUp)('Dev account registration + profile', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: EMAIL } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('rejects login for an unregistered email (/v1/me has no user)', async () => {
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-brayz-user-email': EMAIL },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toBeNull();
  });

  it('registers a new account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/register',
      payload: { email: EMAIL, displayName: 'Test Owner' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ email: EMAIL, displayName: 'Test Owner' });

    // Now /v1/me resolves the user.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-brayz-user-email': EMAIL },
    });
    expect(me.json().user).toMatchObject({ email: EMAIL, displayName: 'Test Owner' });
  });

  it('rejects a duplicate registration with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev/register',
      payload: { email: EMAIL, displayName: 'Someone Else' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('updates the display name via PATCH /v1/me', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { 'x-brayz-user-email': EMAIL },
      payload: { displayName: 'Renamed Owner' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: EMAIL, displayName: 'Renamed Owner' });
  });
});
