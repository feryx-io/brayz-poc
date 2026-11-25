import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BillingConfigError,
  BillingProviderError,
  PLANS,
  StripeBillingProvider,
  entitlementsFor,
  isEntitled,
  planFromPriceId,
  planIncluding,
  snapshotFromSubscription,
  verifyStripeSignature,
  type StripeFetch,
} from '../src/index.js';

const priceIds = { starter: 'price_starter', growth: 'price_growth', pro: 'price_pro' };

function recordingFetch(
  responder: (
    url: string,
    init: { method: string; body?: string },
  ) => {
    ok: boolean;
    status: number;
    body: unknown;
  },
) {
  const calls: Array<{ url: string; method: string; form: URLSearchParams | null }> = [];
  const impl: StripeFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      form: init.body ? new URLSearchParams(init.body) : null,
    });
    const res = responder(url, init);
    return { ok: res.ok, status: res.status, json: async () => res.body };
  };
  return { impl, calls };
}

describe('Plan entitlements', () => {
  it('gives each tier what pricing §10 says it does', () => {
    expect(entitlementsFor('starter', 'active')).toEqual(['calls']);
    expect(entitlementsFor('growth', 'active')).toContain('orders');
    expect(entitlementsFor('growth', 'active')).not.toContain('staff_voices');
    expect(entitlementsFor('pro', 'active')).toContain('staff_voices');
    expect(entitlementsFor('pro', 'active')).toContain('pos');
  });

  it('keeps a past-due location working', () => {
    // A failed card must not stop a restaurant's phone being answered
    // mid-service; cancellation is the lever that ends service.
    expect(isEntitled('growth', 'past_due', 'orders')).toBe(true);
    expect(isEntitled('growth', 'trialing', 'orders')).toBe(true);
  });

  it('entitles nothing once canceled, incomplete, or absent', () => {
    for (const status of ['canceled', 'incomplete', 'none'] as const) {
      expect(entitlementsFor('pro', status), status).toEqual([]);
    }
    expect(entitlementsFor(null, 'active')).toEqual([]);
  });

  it('names the cheapest plan that unlocks something, for an upgrade prompt', () => {
    expect(planIncluding('orders')?.plan).toBe('growth');
    expect(planIncluding('staff_voices')?.plan).toBe('pro');
    expect(planIncluding('calls')?.plan).toBe('starter');
  });

  it('prices the tiers as the plan document does', () => {
    expect(PLANS.starter.monthlyCents).toBe(9900);
    expect(PLANS.growth.monthlyCents).toBe(24900);
    expect(PLANS.pro.monthlyCents).toBe(49900);
  });
});

describe('StripeBillingProvider — checkout', () => {
  const provider = (impl: StripeFetch) =>
    new StripeBillingProvider({ secretKey: 'sk_test_x', priceIds }, impl);

  it('opens a subscription checkout carrying the location it is for', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' },
    }));
    const session = await provider(impl).createCheckout({
      plan: 'growth',
      locationId: 'loc-1',
      tenantId: 'ten-1',
      customerEmail: 'owner@mario.test',
      returnUrl: 'https://app.brayz.test/app/settings',
    });

    expect(session.url).toBe('https://checkout.stripe.com/c/pay/cs_1');
    const form = calls[0].form!;
    expect(calls[0].url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(form.get('mode')).toBe('subscription');
    expect(form.get('line_items[0][price]')).toBe('price_growth');
    // Metadata on the subscription is how the webhook finds the location later
    // — a browser redirect is not something to attach a plan on.
    expect(form.get('subscription_data[metadata][locationId]')).toBe('loc-1');
    expect(form.get('metadata[locationId]')).toBe('loc-1');
    expect(form.get('customer_email')).toBe('owner@mario.test');
  });

  it('reuses an existing customer rather than minting a second one', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/pay/cs_2' },
    }));
    await provider(impl).createCheckout({
      plan: 'pro',
      locationId: 'loc-1',
      tenantId: 'ten-1',
      customerId: 'cus_existing',
      customerEmail: 'owner@mario.test',
      returnUrl: 'https://app.brayz.test/app/settings',
    });
    const form = calls[0].form!;
    expect(form.get('customer')).toBe('cus_existing');
    // Both would be a Stripe error; the customer wins so history stays on one record.
    expect(form.get('customer_email')).toBeNull();
  });

  it('refuses a plan with no price configured instead of charging the wrong one', async () => {
    const { impl } = recordingFetch(() => ({ ok: true, status: 200, body: {} }));
    const p = new StripeBillingProvider(
      { secretKey: 'sk', priceIds: { starter: 'price_s' } },
      impl,
    );
    await expect(
      p.createCheckout({
        plan: 'pro',
        locationId: 'l',
        tenantId: 't',
        returnUrl: 'https://x.test',
      }),
    ).rejects.toBeInstanceOf(BillingConfigError);
  });

  it('surfaces Stripe’s own message when it rejects the call', async () => {
    const { impl } = recordingFetch(() => ({
      ok: false,
      status: 400,
      body: { error: { message: 'No such price: price_growth' } },
    }));
    const err = await provider(impl)
      .createCheckout({
        plan: 'growth',
        locationId: 'l',
        tenantId: 't',
        returnUrl: 'https://x.test',
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BillingProviderError);
    expect(err.message).toContain('No such price');
  });
});

describe('StripeBillingProvider — portal and read-back', () => {
  it('opens a portal session for the customer', async () => {
    const { impl, calls } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: { url: 'https://billing.stripe.com/p/session/x' },
    }));
    const p = new StripeBillingProvider({ secretKey: 'sk', priceIds }, impl);
    const res = await p.createPortal({ customerId: 'cus_1', returnUrl: 'https://app.test/s' });
    expect(res.url).toBe('https://billing.stripe.com/p/session/x');
    expect(calls[0].form!.get('customer')).toBe('cus_1');
  });

  it('normalizes a subscription into Brayz’s own vocabulary', async () => {
    const { impl } = recordingFetch(() => ({
      ok: true,
      status: 200,
      body: {
        id: 'sub_1',
        customer: 'cus_1',
        status: 'active',
        current_period_end: 1790000000,
        cancel_at_period_end: true,
        items: { data: [{ price: { id: 'price_pro' } }] },
      },
    }));
    const p = new StripeBillingProvider({ secretKey: 'sk', priceIds }, impl);
    const snap = await p.getSubscription('sub_1');
    expect(snap).toMatchObject({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      plan: 'pro',
      status: 'active',
      cancelAtPeriodEnd: true,
    });
    expect(snap?.currentPeriodEnd?.getTime()).toBe(1790000000 * 1000);
  });

  it('maps Stripe statuses, and treats an unknown one as incomplete', () => {
    const map = (status: string) =>
      snapshotFromSubscription({ id: 's', customer: 'c', status }, priceIds).status;
    expect(map('trialing')).toBe('trialing');
    expect(map('active')).toBe('active');
    expect(map('past_due')).toBe('past_due');
    expect(map('unpaid')).toBe('past_due');
    expect(map('canceled')).toBe('canceled');
    // Never guess a paying state from a word we don't recognize.
    expect(map('paused')).toBe('incomplete');
    expect(map(undefined as unknown as string)).toBe('incomplete');
  });

  it('reports no plan for a price we do not sell', () => {
    expect(planFromPriceId('price_someone_elses', priceIds)).toBeNull();
    expect(planFromPriceId(undefined, priceIds)).toBeNull();
    expect(planFromPriceId('price_growth', priceIds)).toBe('growth');
  });
});

describe('verifyStripeSignature', () => {
  const secret = 'whsec_test_secret';
  const body = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated' });
  const sign = (raw: string, t: number, key = secret) =>
    `t=${t},v1=${crypto.createHmac('sha256', key).update(`${t}.${raw}`).digest('hex')}`;
  const now = 1_790_000_000_000;
  const t = Math.floor(now / 1000);

  it('accepts a correctly signed body', () => {
    expect(verifyStripeSignature(body, sign(body, t), secret, 300, now)).toBe(true);
  });

  it('rejects a tampered body under a valid signature', () => {
    const header = sign(body, t);
    const tampered = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.deleted' });
    expect(verifyStripeSignature(tampered, header, secret, 300, now)).toBe(false);
  });

  it('rejects the wrong secret, and a header with no signature at all', () => {
    expect(verifyStripeSignature(body, sign(body, t, 'whsec_other'), secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t}`, secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, '', secret, 300, now)).toBe(false);
  });

  it('rejects a captured delivery replayed outside the tolerance', () => {
    const old = t - 3600;
    expect(verifyStripeSignature(body, sign(body, old), secret, 300, now)).toBe(false);
    // Inside the window it is still good.
    expect(verifyStripeSignature(body, sign(body, t - 60), secret, 300, now)).toBe(true);
  });

  it('accepts any matching v1 during a secret rotation', () => {
    // Stripe sends both signatures while two secrets are live.
    const stale = crypto.createHmac('sha256', 'whsec_old').update(`${t}.${body}`).digest('hex');
    const good = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    expect(verifyStripeSignature(body, `t=${t},v1=${stale},v1=${good}`, secret, 300, now)).toBe(
      true,
    );
  });

  it('rejects a signature that is not hex of the right length', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=notahexsignature`, secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=abcd`, secret, 300, now)).toBe(false);
  });
});
