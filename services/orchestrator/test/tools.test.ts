import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type { LlmToolCall } from '@brayz/ai';
import { createApiToolExecutor, createOrderPlacer, createVoiceLoader } from '../src/tools.js';
import type { ConversationContext } from '../src/conversation.js';

const log = pino({ level: 'silent' });
const ctx: ConversationContext = { callId: 'call-9', sampleRate: 8000 };

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, async json() {} };
    return { ok: true, status: 200, async json() {return routes[key];} };
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

function call(name: string, args: Record<string, unknown> = {}): LlmToolCall {
  return { id: 't1', name, arguments: args };
}

describe('API tool executor', () => {
  it('formats hours with closed days', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/hours': { hours: [{ dayOfWeek: 1, opensAt: 660, closesAt: 1260 }] },
    }));
    const out = await exec(call('lookup_hours'), ctx);
    expect(out).toContain('Monday: 11 AM to 9 PM');
    expect(out).toContain('Sunday: closed');
  });

  it('formats menu items with prices from cents', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/menu': { items: [{ name: 'Margherita', priceCents: 1295, description: 'tomato, basil' }] },
    }));
    const out = await exec(call('lookup_menu', { query: 'pizza' }), ctx);
    expect(out).toBe('Margherita — $12.95 (tomato, basil)');
  });

  it('reports an empty menu search', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({ '/tools/menu': { items: [] } }));
    expect(await exec(call('lookup_menu', { query: 'sushi' }), ctx)).toMatch(/no matching/i);
  });

  it('formats the restaurant profile', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/profile': {
        name: "Mario's Pizza", addressLine1: '1 Main St', city: 'Albany', region: 'NY',
        mainPhone: '518-555-0123', pickupEnabled: true, deliveryEnabled: false,
      },
    }));
    const out = await exec(call('lookup_restaurant_profile'), ctx);
    expect(out).toContain("Mario's Pizza");
    expect(out).toContain('1 Main St, Albany, NY');
    expect(out).toContain('Pickup available');
    expect(out).toContain('Delivery not available');
  });

  it('takes a message and tells the bot what it may promise', async () => {
    const f = fakeFetch({ '/tools/message': { id: 'm1', callbackNumber: '+15185551212' } });
    const exec = createApiToolExecutor('http://api', 'secret', log, f);
    const out = await exec(
      call('take_message', { message: 'Wants a callback about a catering order', caller_name: 'Dana' }),
      ctx,
    );
    expect(out).toMatch(/message taken/i);
    expect(out).toContain('+15185551212');
    const recorded = (f as unknown as { calls: { url: string; init?: RequestInit }[] }).calls;
    const post = recorded.find((c) => c.init?.method === 'POST');
    expect(post?.url).toContain('/tools/message');
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ message: 'Wants a callback about a catering order', callerName: 'Dana' });
  });

  it('refuses an empty message without a request', async () => {
    const f = fakeFetch({ '/tools/message': { id: 'm1' } });
    const exec = createApiToolExecutor('http://api', 'secret', log, f);
    expect(await exec(call('take_message', { message: '  ' }), ctx)).toMatch(/no message/i);
    expect((f as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  it('formats loyalty status with an available reward', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/loyalty': {
        enabled: true, enrolled: true, pointsBalance: 290,
        rewardAvailable: true, rewardPoints: 100, rewardCents: 300, pointsPerDollar: 10,
      },
    }));
    const out = await exec(call('check_loyalty'), ctx);
    expect(out).toContain('Points balance: 290');
    expect(out).toContain('$3.00 off this order for 100 points');
  });

  it('reports points-to-go when the reward is not yet reachable', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/loyalty': {
        enabled: true, enrolled: true, pointsBalance: 40,
        rewardAvailable: false, rewardPoints: 100, rewardCents: 300, pointsPerDollar: 10,
      },
    }));
    const out = await exec(call('check_loyalty'), ctx);
    expect(out).toContain('Points balance: 40');
    expect(out).toContain('60 to go');
  });

  it('mentions VIP status and pending birthday/win-back bonuses', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/loyalty': {
        enabled: true, enrolled: true, pointsBalance: 40, vip: true,
        rewardAvailable: false, rewardPoints: 100, rewardCents: 300,
        birthdayBonusAvailable: true, birthdayBonusPoints: 250,
        winbackBonusAvailable: true, winbackBonusPoints: 150,
      },
    }));
    const out = await exec(call('check_loyalty'), ctx);
    expect(out).toContain('VIP regular');
    expect(out).toContain('250-point birthday bonus');
    expect(out).toContain('150-point welcome-back bonus');
  });

  it('passes the birthday through save_guest_memory', async () => {
    const f = fakeFetch({ '/guest/memory': { saved: true } });
    const exec = createApiToolExecutor('http://api', 'secret', log, f);
    const out = await exec(call('save_guest_memory', { birthday_month: 6, birthday_day: 15 }), ctx);
    expect(out).toMatch(/remember/i);
    const recorded = (f as unknown as { calls: { url: string; init?: RequestInit }[] }).calls;
    const post = recorded.find((c) => c.url.includes('/guest/memory'));
    expect(String(post?.init?.body)).toContain('"birthdayMonth":6');
    expect(String(post?.init?.body)).toContain('"birthdayDay":15');
  });

  it('says there is no loyalty program when disabled', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({
      '/tools/loyalty': { enabled: false },
    }));
    expect(await exec(call('check_loyalty'), ctx)).toMatch(/does not have a loyalty program/i);
  });

  it('asks to confirm identity when the API withholds loyalty status (403)', async () => {
    const forbidden = (async () => ({ ok: false, status: 403, async json() {} })) as unknown as typeof fetch;
    const exec = createApiToolExecutor('http://api', 'secret', log, forbidden);
    expect(await exec(call('check_loyalty'), ctx)).toMatch(/confirm who/i);
  });

  it('degrades gracefully on API failure', async () => {
    const exec = createApiToolExecutor('http://api', 'secret', log, fakeFetch({})); // 404 for everything
    expect(await exec(call('lookup_hours'), ctx)).toMatch(/not available/i);
  });
});

describe('voice loader', () => {
  it('returns the staff voice when one answers the call', async () => {
    const load = createVoiceLoader('http://api', 'secret', log, fakeFetch({
      '/tools/voice': { voiceId: 'test-voice-1', staffName: 'Tony' },
    }));
    expect(await load(ctx)).toEqual({ voiceId: 'test-voice-1', staffName: 'Tony' });
  });

  it('returns null for the default voice and on API failure', async () => {
    const load = createVoiceLoader('http://api', 'secret', log, fakeFetch({
      '/tools/voice': { voiceId: null, persona: 'aura-2-thalia-en' },
    }));
    expect(await load(ctx)).toBeNull();
    const failing = createVoiceLoader('http://api', 'secret', log, fakeFetch({}));
    expect(await failing(ctx)).toBeNull();
  });
});

describe('order placer', () => {
  const ctx = { callId: 'call-1' } as ConversationContext;
  const replying = (status: number, body: unknown) =>
    (async () => ({ ok: status < 300, status, async json() { return body; } })) as unknown as typeof fetch;
  const lines = [{ menuItemId: 'mi-1', name: 'Wings', quantity: 1, unitPriceCents: 1200 }];

  it('hands back a menu option rule the API refused the order for', async () => {
    const place = createOrderPlacer(
      'http://api',
      'secret',
      pino({ level: 'silent' }),
      replying(422, { error: { code: 'modifier_limit', message: 'Wings takes at most 1 Sauce choice' } }),
    );
    expect(await place(ctx, lines, {})).toEqual({
      refused: { code: 'modifier_limit', message: 'Wings takes at most 1 Sauce choice' },
    });
  });

  it('still reports any other failure as no order', async () => {
    const log = pino({ level: 'silent' });
    const unavailable = { error: { code: 'item_unavailable', message: 'Item not available: Wings' } };
    expect(await createOrderPlacer('http://api', 's', log, replying(422, unavailable))(ctx, lines, {})).toBeNull();
    expect(await createOrderPlacer('http://api', 's', log, replying(500, {}))(ctx, lines, {})).toBeNull();
  });
});
