import { describe, expect, it } from 'vitest';
import { PLANS, TRIAL_DAYS, TRIAL_PLAN } from '@brayz/billing';
import { LANDING_PLANS, LANDING_TRIAL, formatIncludedCalls, formatMonthly } from '../lib/pricing';

/**
 * The landing page and the sign-up page promise a free trial; sign-up grants
 * one. `TRIAL_DAYS` / `TRIAL_PLAN` are what a new account actually gets, so they
 * win — if this fails, fix `LANDING_TRIAL` in `apps/web/lib/pricing.ts`.
 */
describe('landing page trial matches what sign-up grants', () => {
  it('promises the trial length a new account actually gets', () => {
    expect(LANDING_TRIAL.days).toBe(TRIAL_DAYS);
  });

  it('names the plan the trial actually runs on', () => {
    expect(LANDING_TRIAL.plan).toBe(TRIAL_PLAN);
    expect(LANDING_TRIAL.planName).toBe(PLANS[TRIAL_PLAN].name);
  });
});

/**
 * The marketing page quotes prices; Stripe charges them. `@brayz/billing`'s
 * PLANS is the side that bills, so it wins every disagreement — if this fails,
 * fix `apps/web/lib/pricing.ts`, not the numbers here.
 *
 * The landing page cannot import the billing package directly (it would put the
 * whole billing surface behind a logged-out marketing page), so this is what
 * keeps the two honest.
 */
describe('landing page pricing matches the billing package', () => {
  it('offers exactly the plans billing defines', () => {
    expect(LANDING_PLANS.map((p) => p.plan).sort()).toEqual(Object.keys(PLANS).sort());
  });

  it.each(LANDING_PLANS)('$plan quotes what billing charges', (landing) => {
    const billed = PLANS[landing.plan];
    expect(billed, `no billing plan called "${landing.plan}"`).toBeDefined();
    expect(landing.monthlyCents).toBe(billed.monthlyCents);
    expect(landing.name).toBe(billed.name);
    expect(landing.includedCalls).toBe(billed.includedCalls);
    expect(landing.summary).toBe(billed.summary);
  });

  it('orders the plans cheapest first, so "Everything in <previous>" reads true', () => {
    const prices = LANDING_PLANS.map((p) => p.monthlyCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('marks exactly one plan as the featured one', () => {
    expect(LANDING_PLANS.filter((p) => p.featured)).toHaveLength(1);
  });
});

describe('price formatting', () => {
  it('drops the decimals on a whole number of dollars', () => {
    expect(formatMonthly(9900)).toBe('$99');
    expect(formatMonthly(49900)).toBe('$499');
  });

  it('keeps cents when there are any', () => {
    expect(formatMonthly(9950)).toBe('$99.50');
  });

  it('groups thousands in the call allowance', () => {
    expect(formatIncludedCalls(300)).toBe('300 calls a month');
    expect(formatIncludedCalls(1000)).toBe('1,000 calls a month');
  });
});
