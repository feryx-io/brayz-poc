import { describe, expect, it } from 'vitest';
import { StripeBillingProvider, type StripeFetch } from '../src/index.js';

/**
 * Subscribing during the free trial must not cost the owner the days left:
 * the Checkout session carries the trial's end, and Stripe starts billing then.
 */
function capture() {
  const forms: URLSearchParams[] = [];
  const fetchImpl = (async (_url: string, init: { method: string; body?: string }) => {
    forms.push(new URLSearchParams(init.body ?? ''));
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test', url: 'https://checkout.stripe.test/cs' }) };
  }) as unknown as StripeFetch;
  const provider = new StripeBillingProvider(
    { secretKey: 'sk_test', priceIds: { starter: 'price_s', growth: 'price_g', pro: 'price_p' } },
    fetchImpl,
  );
  return { forms, provider };
}

const base = { plan: 'pro' as const, locationId: 'loc', tenantId: 'ten', returnUrl: 'https://app.test/settings' };
const DAY = 86_400_000;

describe('checkout during a free trial', () => {
  it('starts billing when the trial ends', async () => {
    const { forms, provider } = capture();
    const end = new Date(Date.now() + 10 * DAY);
    await provider.createCheckout({ ...base, trialEndsAt: end });
    expect(forms[0]!.get('subscription_data[trial_end]')).toBe(String(Math.floor(end.getTime() / 1000)));
  });

  it('bills from today when the trial has under 48 hours left, which Stripe would refuse', async () => {
    const { forms, provider } = capture();
    await provider.createCheckout({ ...base, trialEndsAt: new Date(Date.now() + 47 * 3_600_000) });
    expect(forms[0]!.get('subscription_data[trial_end]')).toBeNull();
  });

  it('bills from today with no trial at all', async () => {
    const { forms, provider } = capture();
    await provider.createCheckout(base);
    expect(forms[0]!.get('subscription_data[trial_end]')).toBeNull();
  });
});
