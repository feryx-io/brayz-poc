import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const STAMP = Date.now();
// Numbers nobody else's test file uses.
const CLAIMED_PHONE = '+15185550148';
const OTHER_PHONE = '+15185550149';

describe.skipIf(!dbUp)('Duplicate restaurants at sign-up', () => {
  let app: App;
  let theirs: string; // an existing account with Jimmy's Pizza in Glens Falls
  let mine: string; // the account signing up
  const userIds: string[] = [];

  const headers = (tenantId: string, email: string) => ({
    'x-brayz-user-email': email,
    'x-brayz-tenant-id': tenantId,
    'content-type': 'application/json',
  });
  const MY_EMAIL = `dup-mine-${STAMP}@brayz.test`;

  beforeAll(async () => {
    app = await buildApp();
    theirs = (await prisma.tenant.create({ data: { name: `Their Co ${STAMP}` } })).id;
    mine = (await prisma.tenant.create({ data: { name: `My Co ${STAMP}` } })).id;
    await prisma.location.create({
      data: {
        tenantId: theirs,
        name: "Jimmy's Pizza",
        addressLine1: '123 Main Street',
        city: 'Glens Falls',
        postalCode: '12801',
        mainPhone: CLAIMED_PHONE,
      },
    });
    const user = await prisma.user.create({ data: { email: MY_EMAIL, authSubject: MY_EMAIL } });
    userIds.push(user.id);
    await prisma.userTenantMembership.create({ data: { tenantId: mine, userId: user.id, role: 'owner' } });
  });

  afterAll(async () => {
    await prisma.tenant.delete({ where: { id: theirs } }).catch(() => {});
    await prisma.tenant.delete({ where: { id: mine } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('the check names what it found and nothing about the other account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/locations/duplicate-check',
      headers: headers(mine, MY_EMAIL),
      payload: { name: 'JIMMYS PIZZA', addressLine1: '123 main st.', city: 'glens falls', postalCode: '12801-4321' },
    });
    expect(res.statusCode).toBe(200);
    const kinds = res.json().findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['same_address', 'same_name_nearby']));
    expect(kinds).not.toContain('phone_claimed');
    const text = JSON.stringify(res.json());
    expect(text).not.toContain(CLAIMED_PHONE);
    expect(text).not.toContain(theirs);
    expect(text).not.toContain('Their Co');
  });

  it("a claimed main phone blocks the save outright, even when acknowledged", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: headers(mine, MY_EMAIL),
      payload: { tenantId: mine, name: 'Totally Different Name', mainPhone: CLAIMED_PHONE, acknowledgeDuplicates: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('phone_claimed');
    expect(res.json().error.findings[0]).toMatchObject({ kind: 'phone_claimed', blocking: true });
  });

  it('a same-name restaurant nearby is held until acknowledged, then created and audited', async () => {
    const payload = { tenantId: mine, name: "Jimmy's Pizza", city: 'Glens Falls', mainPhone: OTHER_PHONE };
    const held = await app.inject({ method: 'POST', url: '/v1/locations', headers: headers(mine, MY_EMAIL), payload });
    expect(held.statusCode).toBe(409);
    expect(held.json().error.code).toBe('possible_duplicate');
    expect(held.json().error.findings.map((f: { kind: string }) => f.kind)).toEqual(['same_name_nearby']);
    expect(await prisma.location.count({ where: { tenantId: mine } })).toBe(0);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: headers(mine, MY_EMAIL),
      payload: { ...payload, acknowledgeDuplicates: true },
    });
    expect(created.statusCode).toBe(201);
    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: mine, action: 'location.duplicate_acknowledged' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.metadata).toMatchObject({ name: "Jimmy's Pizza", findings: ['same_name_nearby'] });
    expect(JSON.stringify(audit?.metadata)).not.toContain(CLAIMED_PHONE);
  });

  it('a second location of the same name in the same city under my own account is flagged too', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/locations',
      headers: headers(mine, MY_EMAIL),
      payload: { tenantId: mine, name: "Jimmy's Pizza", city: 'Glens Falls' },
    });
    expect(res.statusCode).toBe(409);
    const kinds = res.json().error.findings.map((f: { kind: string }) => f.kind);
    expect(kinds).toContain('same_name_in_account');
  });

  it('a different city, or a different name, passes without a word', async () => {
    for (const payload of [
      { tenantId: mine, name: "Jimmy's Pizza", city: 'Albany' },
      { tenantId: mine, name: 'Brand New Bistro', city: 'Glens Falls' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/v1/locations', headers: headers(mine, MY_EMAIL), payload });
      expect(res.statusCode).toBe(201);
    }
  });

  it('editing a location to claim someone else\'s phone is refused; editing its greeting is not re-checked', async () => {
    const own = await prisma.location.findFirst({ where: { tenantId: mine, name: 'Brand New Bistro' }, select: { id: true } });
    const phone = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${own!.id}`,
      headers: headers(mine, MY_EMAIL),
      payload: { mainPhone: CLAIMED_PHONE },
    });
    expect(phone.statusCode).toBe(409);
    expect(phone.json().error.code).toBe('phone_claimed');

    const greeting = await app.inject({
      method: 'PATCH',
      url: `/v1/locations/${own!.id}`,
      headers: headers(mine, MY_EMAIL),
      payload: { aiGreetings: ['Hi there.'] },
    });
    expect(greeting.statusCode).toBe(200);
  });
});
