import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BillingProvider, CheckoutRequest, SubscriptionSnapshot } from '@brayz/billing';

process.env.DISABLE_DOTENV = 'true';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://brayz:brayz@localhost:5432/brayz?schema=public';
process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'dev';

const SEEDED_TENANT = '00000000-0000-0000-0000-0000000000a1';
const NODE_SECRET = 'dev-only-change-me';
const WEBHOOK_SECRET = 'whsec_test_secret_for_brayz';
// Unique per test file — billing owns 0136, and its own location + menu.
const TEST_NUMBER = '+15185550136';
const OWNER_EMAIL = `billing-owner-${Date.now()}@brayz.test`;

const { buildApp } = await import('../src/app.js');
const { prisma } = await import('@brayz/db');
const { snapshotFromSubscription } = await import('@brayz/billing');
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

/** A Stripe we can steer, recording what the routes asked it for. */
class FakeStripe implements BillingProvider {
  readonly name = 'stripe';
  checkouts: CheckoutRequest[] = [];
  portals: Array<{ customerId: string }> = [];
  /** What `getSubscription` should report back for a checkout read-back. */
  snapshot: SubscriptionSnapshot | null = null;

  async createCheckout(req: CheckoutRequest) {
    this.checkouts.push(req);
    return { url: `https://checkout.stripe.test/${req.plan}`, sessionId: 'cs_test' };
  }
  async createPortal(req: { customerId: string }) {
    this.portals.push(req);
    return { url: 'https://billing.stripe.test/portal' };
  }
  async getSubscription() {
    return this.snapshot;
  }
}

const stripe = new FakeStripe();

describe.skipIf(!dbUp)('Billing (plans, checkout, webhook, entitlements)', () => {
  let app: App;
  let appNoBilling: App;
  let locationId: string;
  let menuItemId: string;
  let userId: string | undefined;
  const callIds: string[] = [];
  let eventSeq = 0;

  const nextEventId = () => `evt_${Date.now()}_${++eventSeq}`;

  /** POST a Stripe event, signed the way Stripe signs it. */
  function deliver(
    event: Record<string, unknown>,
    opts: { signature?: string | null; target?: App; atMs?: number } = {},
  ) {
    if (typeof event.type === 'string' && event.type.startsWith('customer.subscription.')) {
      const object = (event.data as { object: Record<string, unknown> }).object;
      stripe.snapshot = snapshotFromSubscription(object, {
        starter: 'price_starter', growth: 'price_growth', pro: 'price_pro',
      });
      if (event.type === 'customer.subscription.deleted') stripe.snapshot.status = 'canceled';
    }
    const raw = JSON.stringify(event);
    const t = Math.floor((opts.atMs ?? Date.now()) / 1000);
    const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const signature = opts.signature === undefined ? `t=${t},v1=${v1}` : opts.signature;
    if (signature) headers['stripe-signature'] = signature;
    return (opts.target ?? app).inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers,
      payload: raw,
    });
  }

  function subscriptionEvent(type: string, over: Record<string, unknown> = {}) {
    return {
      id: nextEventId(),
      created: 1_790_000_000 + eventSeq,
      type,
      data: {
        object: {
          id: 'sub_test_1',
          customer: 'cus_test_1',
          status: 'active',
          current_period_end: 1790000000,
          cancel_at_period_end: false,
          items: { data: [{ price: { id: 'price_growth' } }] },
          metadata: { locationId, tenantId: SEEDED_TENANT },
          ...over,
        },
      },
    };
  }

  async function newCall(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: nodeHeaders,
      payload: { provider: 'twilio', fromNumber: '+15185551336', toNumber: TEST_NUMBER },
    });
    const id = res.json().id as string;
    callIds.push(id);
    return id;
  }

  beforeAll(async () => {
    // Price ids the fake events reference, and enforcement on so the gate is
    // actually exercised rather than short-circuited.
    process.env.STRIPE_PRICE_STARTER = 'price_starter';
    process.env.STRIPE_PRICE_GROWTH = 'price_growth';
    process.env.STRIPE_PRICE_PRO = 'price_pro';
    process.env.BILLING_ENFORCED = 'true';

    app = await buildApp({
      notifier: null,
      billingProvider: stripe,
      stripeWebhookSecret: WEBHOOK_SECRET,
    });
    appNoBilling = await buildApp({ notifier: null, billingProvider: null });

    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } });
    const location = await prisma.location.create({
      data: { tenantId: SEEDED_TENANT, name: 'Billing Test Kitchen' },
      select: { id: true },
    });
    locationId = location.id;
    await prisma.phoneNumber.create({
      data: { tenantId: SEEDED_TENANT, locationId, e164Number: TEST_NUMBER },
    });

    const menu = await prisma.menu.create({
      data: { tenantId: SEEDED_TENANT, locationId, name: 'Billing Menu', active: true },
      select: { id: true },
    });
    const category = await prisma.menuCategory.create({
      data: { menuId: menu.id, name: 'Pizza' },
      select: { id: true },
    });
    menuItemId = (
      await prisma.menuItem.create({
        data: { categoryId: category.id, name: 'Pizza', priceCents: 1500 },
        select: { id: true },
      })
    ).id;

    const user = await prisma.user.create({
      data: { email: OWNER_EMAIL, authSubject: OWNER_EMAIL },
    });
    userId = user.id;
    await prisma.userTenantMembership.create({
      data: { tenantId: SEEDED_TENANT, userId: user.id, role: 'owner' },
    });
  });

  afterAll(async () => {
    delete process.env.BILLING_ENFORCED;
    for (const id of callIds) {
      await prisma.order.deleteMany({ where: { callId: id } }).catch(() => {});
      await prisma.call.deleteMany({ where: { id } }).catch(() => {});
    }
    await prisma.webhookDelivery.deleteMany({ where: { source: 'stripe' } }).catch(() => {});
    await prisma.guest.deleteMany({ where: { locationId } }).catch(() => {});
    await prisma.phoneNumber.deleteMany({ where: { e164Number: TEST_NUMBER } }).catch(() => {});
    if (locationId) await prisma.location.deleteMany({ where: { id: locationId } }).catch(() => {});
    if (userId) {
      await prisma.userTenantMembership.deleteMany({ where: { userId } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
    }
    await app.close();
    await appNoBilling.close();
    await prisma.$disconnect();
  });

  it('reports an unsubscribed location without inventing a plan', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/billing`,
      headers: ownerHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      plan: null,
      status: 'none',
      entitlements: [],
      billingAvailable: true,
    });
    // The catalog is served so the dashboard doesn't hard-code prices.
    expect(res.json().plans).toHaveLength(3);
  });

  it('still takes orders for a location that has never subscribed', async () => {
    // Enforcement is about tiers, not about locking out anyone who predates
    // billing — every existing location has no subscription row.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${await newCall()}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('opens a checkout for the plan the owner picked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/billing/checkout`,
      headers: ownerHeaders,
      payload: { plan: 'growth', returnUrl: 'https://app.brayz.test/app/settings' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://checkout.stripe.test/growth');
    expect(stripe.checkouts.at(-1)).toMatchObject({
      plan: 'growth',
      locationId,
      tenantId: SEEDED_TENANT,
      customerEmail: OWNER_EMAIL,
    });
  });

  it('says so when billing is not configured at all', async () => {
    const res = await appNoBilling.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/billing/checkout`,
      headers: ownerHeaders,
      payload: { plan: 'growth', returnUrl: 'https://app.brayz.test/app/settings' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('billing_unavailable');
  });

  it('refuses a portal for a location that has never subscribed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/billing/portal`,
      headers: ownerHeaders,
      payload: { returnUrl: 'https://app.brayz.test/app/settings' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('refuses an unsigned or wrongly-signed webhook', async () => {
    const unsigned = await deliver(subscriptionEvent('customer.subscription.updated'), {
      signature: null,
    });
    expect(unsigned.statusCode).toBe(401);

    const wrong = await deliver(subscriptionEvent('customer.subscription.updated'), {
      signature: 't=1,v1=deadbeef',
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('refuses a captured webhook replayed an hour later', async () => {
    const res = await deliver(subscriptionEvent('customer.subscription.updated'), {
      atMs: Date.now() - 3_600_000,
    });
    expect(res.statusCode).toBe(401);
  });

  it('activates the subscription from the webhook, not from a redirect', async () => {
    const res = await deliver(subscriptionEvent('customer.subscription.created'));
    expect(res.statusCode).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/billing`,
      headers: ownerHeaders,
    });
    expect(state.json()).toMatchObject({
      plan: 'growth',
      status: 'active',
      hasCustomer: true,
    });
    expect(state.json().entitlements).toContain('orders');
    // Growth stops short of Pro.
    expect(state.json().entitlements).not.toContain('staff_voices');
  });

  it('ignores a replayed event rather than moving the subscription backwards', async () => {
    const event = subscriptionEvent('customer.subscription.updated', {
      status: 'canceled',
      items: { data: [{ price: { id: 'price_starter' } }] },
    });
    expect((await deliver(event)).statusCode).toBe(200);
    // Same event id again — Stripe retries until it sees a 2xx.
    const replay = await deliver(event);
    expect(replay.json().duplicate).toBe(true);

    const state = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/billing`,
      headers: ownerHeaders,
    });
    // Applied exactly once: still canceled/starter, not re-applied on top.
    expect(state.json()).toMatchObject({ status: 'canceled', plan: 'starter' });
  });

  it('refuses a paid feature the plan does not include', async () => {
    // Back to a live Starter subscription: calls yes, orders no.
    await deliver(
      subscriptionEvent('customer.subscription.updated', {
        status: 'active',
        items: { data: [{ price: { id: 'price_starter' } }] },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${await newCall()}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error.code).toBe('plan_upgrade_required');
  });

  it('allows it once the plan covers it', async () => {
    await deliver(
      subscriptionEvent('customer.subscription.updated', {
        status: 'active',
        items: { data: [{ price: { id: 'price_growth' } }] },
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${await newCall()}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('keeps taking orders when the card fails', async () => {
    await deliver(
      subscriptionEvent('customer.subscription.updated', {
        status: 'past_due',
        items: { data: [{ price: { id: 'price_growth' } }] },
      }),
    );
    // A restaurant's phone must not stop being useful mid-service over dunning.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/calls/${await newCall()}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('stops the paid feature once the subscription is deleted', async () => {
    const res = await deliver(subscriptionEvent('customer.subscription.deleted'));
    expect(res.statusCode).toBe(200);

    const order = await app.inject({
      method: 'POST',
      url: `/v1/calls/${await newCall()}/order`,
      headers: nodeHeaders,
      payload: { items: [{ menuItemId, name: 'Pizza', quantity: 1 }] },
    });
    expect(order.statusCode).toBe(402);
  });

  it('reports usage for the period, counting answered call time', async () => {
    const callId = await newCall();
    const started = new Date(Date.now() - 5 * 60 * 1000);
    await prisma.call.update({
      where: { id: callId },
      data: {
        startedAt: started,
        answeredAt: started,
        endedAt: new Date(started.getTime() + 3 * 60 * 1000),
      },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/billing`,
      headers: ownerHeaders,
    });
    expect(res.json().usage.calls).toBeGreaterThan(0);
    // The three-minute call above is in there.
    expect(res.json().usage.aiMinutes).toBeGreaterThanOrEqual(3);
  });

  it('opens the portal once a customer exists', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/locations/${locationId}/billing/portal`,
      headers: ownerHeaders,
      payload: { returnUrl: 'https://app.brayz.test/app/settings' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe('https://billing.stripe.test/portal');
    expect(stripe.portals.at(-1)?.customerId).toBe('cus_test_1');
  });

  it('hides one tenant’s billing from another', async () => {
    const other = await prisma.tenant.create({
      data: { name: 'Billing Outsider' },
      select: { id: true },
    });
    const email = `billing-outsider-${Date.now()}@brayz.test`;
    const user = await prisma.user.create({ data: { email, authSubject: email } });
    await prisma.userTenantMembership.create({
      data: { tenantId: other.id, userId: user.id, role: 'owner' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/locations/${locationId}/billing`,
      headers: { 'x-brayz-user-email': email, 'x-brayz-tenant-id': other.id },
    });
    expect(res.statusCode).toBe(404);

    await prisma.userTenantMembership.deleteMany({ where: { userId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.tenant.deleteMany({ where: { id: other.id } });
  });
});
