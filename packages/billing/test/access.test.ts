import { describe, expect, it } from 'vitest';
import { PLANS, accessFor } from '../src/index.js';

const NOW = new Date('2026-09-11T12:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

describe('accessFor — what a location may do, trial included', () => {
  it('gives Pro while the account’s trial runs', () => {
    const a = accessFor({ plan: null, status: 'none', trialEndsAt: inDays(12), now: NOW });
    expect(a).toEqual({ source: 'trial', plan: 'pro', entitlements: PLANS.pro.entitlements, inService: true });
  });

  it('takes the location out of service once the trial lapses with no paid plan', () => {
    const a = accessFor({ plan: null, status: 'none', trialEndsAt: inDays(-1), now: NOW });
    expect(a).toEqual({ source: 'trial_expired', plan: null, entitlements: [], inService: false });
  });

  it('lets a paid plan win over the trial, lapsed or not', () => {
    for (const trialEndsAt of [inDays(5), inDays(-5)]) {
      const a = accessFor({ plan: 'growth', status: 'active', trialEndsAt, now: NOW });
      expect(a.source).toBe('subscription');
      expect(a.plan).toBe('growth');
      expect(a.entitlements).toEqual(PLANS.growth.entitlements);
      expect(a.inService).toBe(true);
    }
  });

  it('keeps serving a failed card, as a paid plan always has', () => {
    const a = accessFor({ plan: 'starter', status: 'past_due', trialEndsAt: inDays(-40), now: NOW });
    expect(a).toMatchObject({ source: 'subscription', inService: true });
  });

  it('falls back to the trial rule when the paid plan is canceled', () => {
    expect(accessFor({ plan: 'pro', status: 'canceled', trialEndsAt: inDays(-3), now: NOW })).toMatchObject({
      source: 'trial_expired',
      inService: false,
    });
    // A checkout started but never finished does not end a running trial.
    expect(accessFor({ plan: null, status: 'incomplete', trialEndsAt: inDays(3), now: NOW }).source).toBe('trial');
  });

  it('leaves an account that never had a trial exactly as it was', () => {
    const a = accessFor({ plan: null, status: 'none', trialEndsAt: null, now: NOW });
    expect(a).toEqual({ source: 'unrestricted', plan: null, entitlements: [], inService: true });
  });

  it('ends the trial at its end instant, not a day later', () => {
    expect(accessFor({ plan: null, status: 'none', trialEndsAt: NOW, now: NOW }).source).toBe('trial_expired');
    expect(
      accessFor({ plan: null, status: 'none', trialEndsAt: new Date(NOW.getTime() + 1), now: NOW }).source,
    ).toBe('trial');
  });
});
