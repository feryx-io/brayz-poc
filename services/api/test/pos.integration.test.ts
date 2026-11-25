import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ManualTicketProvider,
  PosCapabilityError,
  PosPermanentError,
  type PosOrder,
  type PosProvider,
} from '@brayz/pos';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
// Unique per test file — POS owns 0131, and its own location so its integration
// writes never race the orders/staff files.
const TEST_NUMBER = '+15185550131';
const OWNER_EMAIL = `pos-owner-${Date.now()}@brayz.test`;
const OTHER_OWNER_EMAIL = `pos-outsider-${Date.now()}@brayz.test`;

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
/** GET/DELETE and bodiless POSTs must not claim a JSON body they don't send. */
const ownerHeadersNoBody = {
  'x-brayz-user-email': OWNER_EMAIL,
  'x-brayz-tenant-id': SEEDED_TENANT,
};

/**
 * A POS we can steer: `mode` decides whether the next push succeeds, and every
 * call is recorded so a test can prove the ticket was raised exactly once.
 */
class FakePosProvider implements PosProvider {
  readonly name = 'square' as const;
  readonly capabilities = {
    createOrder: true,
    updateOrderStatus: true,
    getMenu: true,
    syncMenu: false,
  };
  mode: 'ok' | 'transient' | 'permanent' = 'ok';
  created: PosOrder[] = [];
  statuses: Array<{ externalOrderId: string; status: string }> = [];
  seq = 0;

  async createOrder(_conn: unknown, order: PosOrder) {
    if (this.mode === 'transient') throw new Error('Square unreachable');
    if (this.mode === 'permanent') throw new PosPermanentError('Invalid line item', 400);
    this.created.push(order);
    return { externalOrderId: `SQ-${++this.seq}` };
  }

  async updateOrderStatus(_conn: unknown, externalOrderId: string, status: string) {
    this.statuses.push({ externalOrderId, status });
  }

  async getMenu() {
    return [
      { externalItemId: 'SQ-ITEM-1', name: 'Square Special', priceCents: 1234, available: true },
    ];
  }

  async syncMenu(): Promise<void> {
    throw new PosCapabilityError('square', 'syncMenu');
  }
}

const fakePos = new FakePosProvider();

describe.skipIf(!dbUp)('POS integrations (config + order push + retry + status)', () => {
  let app: App;
  let locationId: string;
  let menuItemId: string;
  let userId: string | undefined;
  let outsiderUserId: string | undefined;
  let otherTenantId: string | undefined;
  const createdCallIds: string[] = [];

  /** Place an order on a fresh call and return the response body. */
  async function placeOrder(customerName = 'Gray') {
    const call = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551332', toNumber: TEST_NUMBER },
    });
    const callId = call.json().id as string;
    createdCallIds.push(callId);
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }], customerName },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; orderCode: string; posStatus: string };
  }

  async function configureManual() {
    return app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: { provider: 'manual', enabled: true },
    });
  }

  async function configureSquare() {
    return app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: {
        provider: 'square',
        enabled: true,
        externalLocationId: 'SQ-LOC-1',
        accessToken: 'super-secret-token',
        environment: 'sandbox',
      },
    });
  }

  beforeAll(async () => {
    app = await buildApp({
      notifier: null, // no SMS on this path; the POS push is what's under test
      posProviders: (provider) => {
        if (provider === 'square') return fakePos;
        if (provider === 'manual') return new ManualTicketProvider();
        return null;
      },
    });

    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'POS Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });

    // Its own menu, so pricing here can't be disturbed by another test file.
    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'POS Test Menu', active: true },
      select: { id: true },
    });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza' },
      select: { id: true },
    });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Large cheese pizza', priceCents: 1499 },
      select: { id: true },
    });
    menuItemId = item.id;

    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });

    // A second tenant, to prove one tenant cannot touch another's integration.
    const other = await prisma.tenant.create({ data: { name: 'Other Co' }, select: { id: true } });
    otherTenantId = other.id;
    const outsider = await prisma.user.create({
      data: { email: OTHER_OWNER_EMAIL, authSubject: OTHER_OWNER_EMAIL },
    });
    outsiderUserId = outsider.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: other.id, userId: outsider.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    for (const callId of createdCallIds) {
      await prisma.order.deleteMany({ where: { callId } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id: callId } }).catch(() => {});
    }
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    // Integration, menu, and sync rows cascade with the location.
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    for (const id of [userId, outsiderUserId]) {
      if (!id) continue;
      await prisma.userTenantMembership.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id } }).catch(() => {});
    }
    if (otherTenantId)
      await prisma.tenant.deleteMany({ where: { id: otherTenantId } }).catch(() => {});
    await app.close();
    await prisma.$disconnect();
  });

  it('reports no POS before one is configured, and skips the push', async () => {
    const before = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
    });
    expect(before.json()).toMatchObject({ configured: false, enabled: false });

    const order = await placeOrder();
    // The order still stands — a missing POS is not an order failure (rule #3).
    expect(order.posStatus).toBe('skipped');
    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(sync).toBeNull();
  });

  it('refuses a vendor POS with no credentials', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: { provider: 'square', enabled: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('raises a manual ticket numbered by the code the guest was given', async () => {
    expect((await configureManual()).statusCode).toBe(200);
    const order = await placeOrder();
    expect(order.posStatus).toBe('synced');

    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(sync).toMatchObject({
      provider: 'manual',
      status: 'synced',
      externalOrderId: `manual:${order.orderCode}`,
      attempts: 1,
    });
    expect(sync?.syncedAt).toBeTruthy();
  });

  it('never returns the access token, only whether one is on file', async () => {
    expect((await configureSquare()).statusCode).toBe(200);
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
    });
    const body = res.json();
    expect(body).toMatchObject({ provider: 'square', hasAccessToken: true, configured: true });
    expect(JSON.stringify(body)).not.toContain('super-secret-token');
  });

  it('keeps the stored token when an update omits it', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: {
        provider: 'square',
        enabled: true,
        externalLocationId: 'SQ-LOC-2',
        environment: 'sandbox',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ hasAccessToken: true, externalLocationId: 'SQ-LOC-2' });
  });

  it('pushes a confirmed order to the vendor POS', async () => {
    await configureSquare();
    fakePos.mode = 'ok';
    const before = fakePos.created.length;
    const order = await placeOrder('Robin');

    expect(order.posStatus).toBe('synced');
    expect(fakePos.created.length).toBe(before + 1);
    const pushed = fakePos.created[fakePos.created.length - 1];
    // Brayz's own prices reach the POS — the LLM never computed these (rule #5).
    expect(pushed).toMatchObject({
      orderId: order.id,
      orderCode: order.orderCode,
      customerName: 'Robin',
      totalCents: 1499,
      lines: [{ name: 'Large cheese pizza', quantity: 1, unitPriceCents: 1499 }],
    });
  });

  it('keeps the order when the POS is down, and records the failure for retry', async () => {
    await configureSquare();
    fakePos.mode = 'transient';
    const order = await placeOrder();

    // The guest's order is confirmed regardless — Brayz is the system of record.
    expect(order.posStatus).toBe('failed');
    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(sync).toMatchObject({ status: 'failed', attempts: 1, externalOrderId: null });
    expect(sync?.lastError).toContain('Square unreachable');

    // It shows up on the Orders screen as a ticket that never landed.
    const list = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/orders`,
      headers: ownerHeaders,
    });
    const row = (list.json() as Array<{ id: string; pos: { status: string } | null }>).find(
      (o) => o.id === order.id,
    );
    expect(row?.pos).toMatchObject({ status: 'failed', provider: 'square' });

    // Once Square is back, the retry raises the ticket and clears the error.
    fakePos.mode = 'ok';
    const retry = await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pos/retry`,
      headers: ownerHeadersNoBody,
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'synced' });

    const after = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(after).toMatchObject({ status: 'synced', attempts: 2 });
    expect(after?.lastError).toBeNull();
  });

  it('does not raise a second ticket when an already-synced order is retried', async () => {
    await configureSquare();
    fakePos.mode = 'ok';
    const order = await placeOrder();
    const pushesAfterOrder = fakePos.created.length;

    const retry = await app.inject({
      method: 'POST',
      url: `/v1/orders/${order.id}/pos/retry`,
      headers: ownerHeadersNoBody,
    });
    expect(retry.statusCode).toBe(200);
    // Idempotent (rule #7): the existing ticket is returned, not a new one.
    expect(fakePos.created.length).toBe(pushesAfterOrder);
    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(sync).toMatchObject({ status: 'synced', attempts: 1 });
  });

  it('marks a permanently-rejected push failed without retrying it forever', async () => {
    await configureSquare();
    fakePos.mode = 'permanent';
    const order = await placeOrder();
    expect(order.posStatus).toBe('failed');
    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: order.id } });
    expect(sync?.status).toBe('failed');
    expect(sync?.lastError).toContain('Invalid line item');
    fakePos.mode = 'ok';
  });

  it('moves an order along and tells the POS about terminal states', async () => {
    await configureSquare();
    fakePos.mode = 'ok';
    const order = await placeOrder();
    const before = fakePos.statuses.length;

    const ready = await app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: ownerHeaders,
      payload: { status: 'ready' },
    });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready' });
    expect(fakePos.statuses[fakePos.statuses.length - 1]).toMatchObject({ status: 'ready' });

    const done = await app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: ownerHeaders,
      payload: { status: 'completed' },
    });
    expect(done.statusCode).toBe(200);
    expect(fakePos.statuses.length).toBe(before + 2);

    // A completed order is final — reopening it would desync the till.
    const again = await app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: ownerHeaders,
      payload: { status: 'ready' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('rejects a status the dashboard may not set', async () => {
    const order = await placeOrder();
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/orders/${order.id}`,
      headers: ownerHeaders,
      payload: { status: 'draft' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reads the vendor catalog through the adapter', async () => {
    await configureSquare();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/pos/menu`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { externalItemId: 'SQ-ITEM-1', name: 'Square Special', priceCents: 1234, available: true },
    ]);
  });

  it('refuses a catalog read from a POS that cannot do one', async () => {
    await configureManual();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/pos/menu`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('pos_capability_unsupported');
  });

  it('hides one tenant’s integration from another', async () => {
    await configureSquare();
    const outsiderHeaders = {
      'x-brayz-user-email': OTHER_OWNER_EMAIL,
      'x-brayz-tenant-id': otherTenantId!,
      'content-type': 'application/json',
    };
    const read = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/pos`,
      headers: outsiderHeaders,
    });
    expect(read.statusCode).toBe(404);

    const write = await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: outsiderHeaders,
      payload: { provider: 'manual', enabled: true },
    });
    expect(write.statusCode).toBe(404);
  });

  it('stops pushing once the integration is switched off', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeaders,
      payload: { provider: 'square', enabled: false, externalLocationId: 'SQ-LOC-1' },
    });
    const before = fakePos.created.length;
    const order = await placeOrder();
    expect(order.posStatus).toBe('skipped');
    expect(fakePos.created.length).toBe(before);
  });

  it('forgets the credentials when the integration is deleted', async () => {
    await configureSquare();
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/locations/${locationId}/pos`,
      headers: ownerHeadersNoBody,
    });
    expect(del.statusCode).toBe(204);
    expect(await prisma.posIntegration.findUnique({ where: { locationId } })).toBeNull();
  });
});
