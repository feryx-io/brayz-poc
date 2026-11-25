import { beforeAll, describe, expect, it } from 'vitest';

// Configure env before anything imports @brayz/config.
process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL ??= 'postgresql://brayz:brayz@localhost:5432/brayz';
process.env.NODE_ENV = 'test';

const { buildApp } = await import('../src/app.js');
type App = Awaited<ReturnType<typeof buildApp>>;

describe('API smoke (no DB required)', () => {
  let app: App;
  beforeAll(async () => {
    app = await buildApp();
  });

  it('GET /healthz → ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('GET /v1/me without auth → unauthenticated', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ authenticated: false });
  });

  it('POST /v1/tenants with empty name → 400 validation_error', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      payload: { name: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });

  it('GET /v1/locations without tenant context → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/locations' });
    expect(res.statusCode).toBe(401);
  });
});
