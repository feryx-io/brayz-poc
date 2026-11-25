import crypto from 'node:crypto';
import { alertsCleanup, alertsOn } from './helpers/smsConsent.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionSnapshot } from '@brayz/billing';
import type { Prisma } from '@brayz/db';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';
process.env.LOG_LEVEL = 'silent';
process.env.STRIPE_PRICE_GROWTH = 'price_growth';

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const transaction = prisma.$transaction.bind(prisma);
const secret = 'p1-regression-webhook-secret';
const nodeHeaders = { 'x-brayz-node-secret': 'dev-only-change-me' };
let dbUp = true;
try {
  await prisma.$queryRaw`SELECT 1`;
} catch (error) {
  if (process.env.TEST_DATABASE_URL) throw error;
  dbUp = false;
}

describe.skipIf(!dbUp)('P1 consistency regressions', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let tenantId: string;
  let locationId: string;
  let guestId: string;
  let callId: string;
  let menuItemId: string;
  let providerState: SubscriptionSnapshot | null;
  const eventIds: string[] = [];
  const messages: string[] = [];
  const getSubscription = vi.fn(async () => providerState);

  beforeAll(async () => {
    app = await buildApp({
      geocoder: null,
      notifier: {
        name: 'test',
        async sendSms(message) {
          messages.push(message.body);
          return { providerMessageId: 'test' };
        },
      },
      billingProvider: {
        name: 'stripe',
        getSubscription,
        async createCheckout() {
          return { url: 'https://checkout.test', sessionId: 'session' };
        },
        async createPortal() {
          return { url: 'https://portal.test' };
        },
      },
      stripeWebhookSecret: secret,
      siphonWebhookSecret: secret,
    });
    const tenant = await prisma.tenant.create({ data: { name: 'P1 regression tests' } });
    tenantId = tenant.id;
    const location = await prisma.location.create({
      data: { tenantId, name: 'Test kitchen', mainPhone: '+15185550199' },
    });
    locationId = location.id;
    // Texts go only to a number whose owner agreed (lib/smsConsent.ts).
    await alertsOn(prisma, tenantId, locationId, '+15185550199');
    const guest = await prisma.guest.create({ data: { tenantId, locationId } });
    guestId = guest.id;
    const call = await prisma.call.create({
      data: { tenantId, locationId, guestId, provider: 'twilio', recordingId: crypto.randomUUID() },
    });
    callId = call.id;
    const menu = await prisma.menu.create({ data: { tenantId, locationId, active: true } });
    const category = await prisma.menuCategory.create({ data: { menuId: menu.id, name: 'Pizza' } });
    const item = await prisma.menuItem.create({
      data: { categoryId: category.id, name: 'Pizza', priceCents: 1200 },
    });
    menuItemId = item.id;
  });

  beforeEach(async () => {
    await prisma.locationSubscription.deleteMany({ where: { locationId } });
    providerState = {
      subscriptionId: 'sub_p1',
      customerId: 'cus_p1',
      plan: 'growth',
      status: 'canceled',
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
    };
    messages.length = 0;
    getSubscription.mockClear();
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (locationId) await alertsCleanup(prisma, locationId);
    if (tenantId) await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.webhookDelivery.deleteMany({ where: { eventId: { in: eventIds } } });
    await app.close();
    await prisma.$disconnect();
  });

  function event(created: number, status = 'active', type = 'customer.subscription.updated') {
    const id = crypto.randomUUID();
    eventIds.push(id);
    return {
      id,
      created,
      type,
      data: {
        object: {
          id: 'sub_p1',
          customer: 'cus_p1',
          status,
          items: { data: [{ price: { id: 'price_growth' } }] },
          metadata: { tenantId, locationId },
        },
      },
    };
  }

  function deliver(source: 'stripe' | 'siphon', body: object, eventId = crypto.randomUUID()) {
    eventIds.push(eventId);
    const raw = JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${raw}`)
      .digest('hex');
    return app.inject({
      method: 'POST',
      url: `/v1/webhooks/${source}`,
      payload: raw,
      headers: {
        'content-type': 'application/json',
        [source === 'stripe' ? 'stripe-signature' : 'x-siphonai-signature']:
          `t=${timestamp},v1=${signature}`,
        'x-siphonai-event-id': eventId,
      },
    });
  }

  function hookTransaction(hook: (tx: Prisma.TransactionClient) => void) {
    vi.spyOn(prisma, '$transaction').mockImplementationOnce(((callback, options) =>
      transaction(async (tx) => {
        hook(tx);
        return callback(tx);
      }, options)) as typeof prisma.$transaction);
  }

  it.each(['stripe', 'siphon'] as const)(
    'does not acknowledge a %s database claim failure',
    async (source) => {
      hookTransaction((tx) => {
        vi.spyOn(tx.webhookDelivery, 'createMany').mockRejectedValueOnce(
          new Error('database unavailable'),
        );
      });
      const body = source === 'stripe' ? event(100) : { type: 'call_start' };
      const response = await deliver(source, body);
      expect(response.statusCode).toBe(500);
      expect(response.json().duplicate).toBeUndefined();
    },
  );

  it('rolls back a failed billing update and processes its retry exactly once', async () => {
    providerState!.status = 'active';
    const body = event(100);
    hookTransaction((tx) => {
      vi.spyOn(tx.locationSubscription, 'upsert').mockRejectedValueOnce(new Error('write failed'));
    });
    expect((await deliver('stripe', body)).statusCode).toBe(500);
    expect(
      await prisma.webhookDelivery.count({ where: { source: 'stripe', eventId: body.id } }),
    ).toBe(0);
    const responses = await Promise.all([deliver('stripe', body), deliver('stripe', body)]);
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(responses.filter((response) => response.json().duplicate)).toHaveLength(1);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'active',
    });
  });

  it('rolls back recording updates when the audit fails, then retries', async () => {
    const call = await prisma.call.findUniqueOrThrow({ where: { id: callId } });
    const body = {
      type: 'recording_uploaded',
      recording_id: call.recordingId,
      url: 's3://recordings/p1',
    };
    const eventId = crypto.randomUUID();
    hookTransaction((tx) => {
      vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    });
    expect((await deliver('siphon', body, eventId)).statusCode).toBe(500);
    expect(
      (await prisma.call.findUniqueOrThrow({ where: { id: callId } })).recordingUrl,
    ).toBeNull();
    expect(await prisma.webhookDelivery.count({ where: { source: 'siphon', eventId } })).toBe(0);
    expect((await deliver('siphon', body, eventId)).statusCode).toBe(200);
    expect((await deliver('siphon', body, eventId)).json().duplicate).toBe(true);
    expect(
      await prisma.auditLog.count({ where: { targetId: callId, action: 'recording.stored' } }),
    ).toBe(1);
  });

  it('retries an upload that arrives before its call can be correlated', async () => {
    const recordingId = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const body = {
      type: 'recording_uploaded',
      timestamp: new Date().toISOString(),
      recording_id: recordingId,
      url: 's3://recordings/early',
    };
    expect((await deliver('siphon', body, eventId)).statusCode).toBe(503);
    await prisma.call.update({ where: { id: callId }, data: { recordingId } });
    expect((await deliver('siphon', body, eventId)).statusCode).toBe(200);
  });

  it('does not let older subscription or checkout events overwrite cancellation', async () => {
    expect((await deliver('stripe', event(200, 'canceled'))).statusCode).toBe(200);
    expect((await deliver('stripe', event(100))).statusCode).toBe(200);
    const checkout = event(150, 'active', 'checkout.session.completed');
    Object.assign(checkout.data.object, { subscription: 'sub_p1' });
    expect((await deliver('stripe', checkout)).statusCode).toBe(200);
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'canceled',
    });
  });

  it('serializes concurrent billing updates and resolves equal timestamps from the provider', async () => {
    const responses = await Promise.all([
      deliver('stripe', event(200, 'canceled')),
      deliver('stripe', event(100)),
    ]);
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect((await deliver('stripe', event(200))).statusCode).toBe(200);
    expect(getSubscription).toHaveBeenCalledWith('sub_p1');
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'canceled',
    });
  });

  it('retries checkout reconciliation after provider failure without downgrading billing', async () => {
    providerState!.status = 'active';
    await deliver('stripe', event(100));
    providerState!.status = 'canceled';
    const checkout = event(200, 'active', 'checkout.session.completed');
    Object.assign(checkout.data.object, { subscription: 'sub_p1' });
    getSubscription.mockRejectedValueOnce(new Error('provider unavailable'));
    expect((await deliver('stripe', checkout)).statusCode).toBe(500);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'active',
    });
    expect((await deliver('stripe', checkout)).statusCode).toBe(200);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'canceled',
    });
  });

  it('keeps provider state newer than the checkout event when intermediate events arrive', async () => {
    const checkout = event(100, 'active', 'checkout.session.completed');
    Object.assign(checkout.data.object, { subscription: 'sub_p1' });
    expect((await deliver('stripe', checkout)).statusCode).toBe(200);
    expect((await deliver('stripe', event(200))).statusCode).toBe(200);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'canceled',
    });
  });

  it('acknowledges a subscription event that names no location of ours', async () => {
    // Retrying cannot make it ours, and a Stripe endpoint that keeps failing
    // gets disabled — losing every other location's events with it.
    const stray = event(300);
    Object.assign(stray.data.object, { id: 'sub_elsewhere', customer: 'cus_elsewhere', metadata: {} });
    const res = await deliver('stripe', stray);
    expect(res.statusCode).toBe(200);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toBeNull();
  });

  it('does not pull a live location back onto a subscription it moved off', async () => {
    providerState = { ...providerState!, subscriptionId: 'sub_new', status: 'active' };
    const current = event(200);
    Object.assign(current.data.object, { id: 'sub_new' });
    expect((await deliver('stripe', current)).statusCode).toBe(200);
    // The old subscription's deletion lands later.
    providerState = { ...providerState!, subscriptionId: 'sub_old', status: 'canceled' };
    const oldDeleted = event(300, 'canceled', 'customer.subscription.deleted');
    Object.assign(oldDeleted.data.object, { id: 'sub_old' });
    expect((await deliver('stripe', oldDeleted)).statusCode).toBe(200);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      stripeSubscriptionId: 'sub_new',
      status: 'active',
    });
  });

  it('reads Stripe without holding the location locked', async () => {
    providerState!.status = 'active';
    getSubscription.mockImplementationOnce(async () => {
      // A write to the location while Stripe is being read must not wait on
      // the webhook: a call or order for this restaurant would be waiting too.
      await transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '500ms'`;
        await tx.$executeRaw`UPDATE locations SET name = name WHERE id = ${locationId}::uuid`;
      });
      return providerState;
    });
    expect((await deliver('stripe', event(100))).statusCode).toBe(200);
  });

  it('abandons a Stripe read that a newer event overtook, rather than writing it', async () => {
    providerState!.status = 'active';
    getSubscription.mockImplementationOnce(async () => {
      const stale = { ...providerState! };
      // While this read is in flight, the subscription is canceled and that
      // event is applied first.
      providerState!.status = 'canceled';
      expect((await deliver('stripe', event(300, 'canceled'))).statusCode).toBe(200);
      return stale;
    });
    expect((await deliver('stripe', event(200))).statusCode).toBe(200);
    expect(await prisma.locationSubscription.findUnique({ where: { locationId } })).toMatchObject({
      status: 'canceled',
    });
  });

  it('rolls back tenant creation when owner membership cannot be saved', async () => {
    const name = `rollback-${crypto.randomUUID()}`;
    const email = `${name}@example.test`;
    hookTransaction((tx) => {
      vi.spyOn(tx.userTenantMembership, 'create').mockRejectedValueOnce(
        new Error('membership failed'),
      );
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants',
      headers: { 'x-brayz-user-email': email },
      payload: { name },
    });
    expect(response.statusCode).toBe(500);
    expect(await prisma.tenant.count({ where: { name } })).toBe(0);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  async function newOrder() {
    return prisma.order.create({
      data: {
        tenantId,
        locationId,
        guestId,
        subtotalCents: 1200,
        totalCents: 1200,
        items: { create: [{ menuItemId, name: 'Pizza', quantity: 1, unitPriceCents: 1200 }] },
      },
    });
  }

  function amend(orderId: string, quantity = 2) {
    return app.inject({
      method: 'PATCH',
      url: `/v1/calls/${callId}/order/${orderId}`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity }] },
    });
  }

  it('rejects an amendment if the kitchen accepts after the initial lookup', async () => {
    const order = await newOrder();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (callback, options) => {
      entered();
      await resume;
      return transaction(callback, options);
    }) as typeof prisma.$transaction);
    const pending = amend(order.id).then((response) => response);
    await waiting;
    try {
      const accepted = await app.inject({
        method: 'PATCH',
        url: `/v1/orders/${order.id}`,
        headers: { 'x-brayz-tenant-id': tenantId },
        payload: { status: 'accepted' },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(409);
    const saved = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { items: true },
    });
    expect(saved).toMatchObject({ status: 'accepted', totalCents: 1200 });
    expect(saved.items[0].quantity).toBe(1);
    expect(messages).toHaveLength(0);
  });

  it('rejects a stale amendment after a competing amendment has committed', async () => {
    const order = await newOrder();
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(prisma, '$transaction').mockImplementationOnce((async (callback, options) => {
      entered();
      await resume;
      return transaction(callback, options);
    }) as typeof prisma.$transaction);
    const pending = amend(order.id, 2).then((response) => response);
    await waiting;
    try {
      expect((await amend(order.id, 3)).statusCode).toBe(200);
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(409);
    expect(await prisma.order.findUnique({ where: { id: order.id } })).toMatchObject({
      totalCents: 3600,
      revision: 1,
    });
    expect(messages).toHaveLength(1);
  });
});
