import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Build the app in firebase mode WITHOUT a live token. Unauthenticated requests
// never touch the DB or firebase-admin (the verifier only loads it for a Bearer
// token), so this runs offline.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'firebase';
process.env.FIREBASE_PROJECT_ID = 'brayz-dev';

const { buildApp } = await import('../src/app.js');
type App = Awaited<ReturnType<typeof buildApp>>;

describe('firebase auth mode', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('rejects protected routes with no credential', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locations' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects tenant creation without a verified identity, including forged dev headers', async () => {
    for (const headers of [{}, { 'x-brayz-user-email': 'owner@example.test' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/tenants',
        headers,
        payload: { name: 'Anonymous restaurant' },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('does NOT trust the dev tenant header in firebase mode', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { 'x-brayz-tenant-id': '00000000-0000-0000-0000-0000000000a1' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed Bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/locations',
      headers: { authorization: 'Bearer not-a-real-token', 'x-brayz-tenant-id': 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('healthz stays public', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
