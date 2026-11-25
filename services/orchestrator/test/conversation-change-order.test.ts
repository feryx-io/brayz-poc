import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { ConversationEngine, type MenuItemInfo, type OrderLine } from '../src/conversation.js';
import type { RecentOrder } from '../src/tools.js';

class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}
class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    opts.onAudio(new Uint8Array(320));
  }
}

/** Drives the change: look it up, open it, add a Coke, read back, save. */
class ChangeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const msgs = opts.messages;
    const last = msgs[msgs.length - 1]!;
    if (last.role === 'tool') {
      for (const ch of last.content.match(/[\s\S]{1,8}/g) ?? []) opts.onEvent({ type: 'text', textDelta: ch });
      opts.onEvent({ type: 'done' });
      return;
    }
    const said = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const call = (name: string, args: Record<string, unknown> = {}) =>
      opts.onEvent({ type: 'tool_call', toolCall: { id: `t-${name}`, name, arguments: args } });
    if (/forgot|change my order|just ordered/i.test(said)) call('lookup_recent_order');
    else if (/code is/i.test(said)) call('confirm_order_code', { code: said.replace(/.*code is /i, '') });
    else if (/cancel/i.test(said)) call('cancel_order');
    else if (/add a coke/i.test(said)) call('change_order');
    else if (/^yes|go ahead|save/i.test(said)) call('place_order');
    // "that's everything" rather than "read it back": the fake model speaks
    // tool instructions verbatim, so a caller line that quotes one comes back
    // as our own echo — which is the suppression working, not a bug.
    else if (/everything/i.test(said)) call('review_order');
    else call('add_item', { item: 'Coke', quantity: 1 });
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [
  { id: 'mi-1', name: 'Large Cheese', priceCents: 1900 },
  { id: 'mi-2', name: 'Coke', priceCents: 300 },
];

const PLACED: Extract<RecentOrder, { needsCode: false }> = {
  found: true,
  needsCode: false,
  orderId: 'order-1',
  orderCode: 'C56FB',
  placedAt: '2026-09-13T00:00:00.000Z',
  fulfillmentType: 'delivery',
  scheduledFor: null,
  customerName: 'James',
  subtotalCents: 1900,
  deliveryFeeCents: 100,
  totalCents: 2000,
  items: [
    {
      menuItemId: 'mi-1',
      name: 'Large Cheese',
      quantity: 1,
      unitPriceCents: 1900,
      specialInstructions: null,
      modifiers: [],
    },
  ],
  posTicket: false,
};

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('Conversation engine — changing an order already placed', () => {
  let engine: ConversationEngine | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  function build(
    opts: {
      recent?: RecentOrder;
      confirm?: { confirmed: boolean; attemptsLeft?: number };
      refuseChange?: string;
      refuseCancel?: string;
    } = {},
  ) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const changed: Array<{ orderId: string; lines: OrderLine[] }> = [];
    const placed: OrderLine[][] = [];
    const canceled: string[] = [];
    engine = new ConversationEngine({
      providers: { stt, llm: new ChangeLlm(), tts },
      context: { callId: 'call-change', sampleRate: 8000, restaurantName: "Jimmy's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => MENU,
      loadProfile: async () => ({ orderAckMode: 'natural' as const, pickupEnabled: true, deliveryEnabled: true }),
      loadRecentOrder: async () => opts.recent ?? PLACED,
      confirmRecentOrder: async () => opts.confirm ?? { confirmed: true, ...PLACED },
      changeOrder: async (_ctx, orderId, lines) => {
        changed.push({ orderId, lines });
        if (opts.refuseChange)
          return { ok: false as const, code: opts.refuseChange, message: 'The order changed' };
        return { ok: true as const, orderCode: 'C56FB', totalCents: 2300, posTicket: false };
      },
      cancelOrder: async (_ctx, orderId) => {
        canceled.push(orderId);
        if (opts.refuseCancel) return { ok: false, code: opts.refuseCancel };
        return { ok: true, orderCode: 'C56FB' };
      },
      placeOrder: async (_ctx, lines) => {
        placed.push(lines);
        return { orderCode: 'NEWWW', totalCents: 999 };
      },
    });
    return { stt, tts, changed, placed, canceled, all: () => tts.spoken.join(' ') };
  }

  it('reads the order back, adds what they forgot, and saves it to the same order', async () => {
    const { stt, tts, changed, placed, all } = build();
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'I just ordered and I forgot something', isFinal: true });
    await waitFor(() => /Their order #C56FB/.test(all()));
    // Read back before anything is touched — that is how a wrong order is caught.
    expect(all()).toContain('1 Large Cheese');
    expect(all()).toContain('$20.00');

    stt.onSegment!({ text: 'can you add a coke', isFinal: true });
    await waitFor(() => /open for changes/.test(all()));

    stt.onSegment!({ text: 'a coke please', isFinal: true });
    await waitFor(() => /Added 1 Coke/.test(all()));

    stt.onSegment!({ text: "okay that's everything", isFinal: true });
    await waitFor(() => /changed order/i.test(all()));
    // Agreed to in its own words: "place the order" invites a second dinner.
    expect(all()).toContain('Should I save that change?');

    stt.onSegment!({ text: 'yes, save it', isFinal: true });
    await waitFor(() => changed.length === 1);
    // Saved back to the order that exists, and no second order created.
    expect(changed[0]!.orderId).toBe('order-1');
    expect(changed[0]!.lines.map((l) => l.name)).toEqual(['Large Cheese', 'Coke']);
    expect(placed).toHaveLength(0);
    await waitFor(() => /now \$23\.00/.test(all()));
    expect(tts.spoken.join(' ')).not.toContain('NEWWW');
  });

  it('says nothing about the order until the code checks out', async () => {
    const { stt, all } = build({
      recent: { found: true, needsCode: true, attemptsLeft: 2 },
      confirm: { confirmed: false, attemptsLeft: 1 },
    });
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'I want to change my order', isFinal: true });
    await waitFor(() => /confirmation code/i.test(all()));
    // Not a line of it, not the total.
    expect(all()).not.toContain('Large Cheese');
    expect(all()).not.toContain('$20.00');

    stt.onSegment!({ text: 'the code is ZZZZZ', isFinal: true });
    await waitFor(() => /does not match/i.test(all()));
    expect(all()).not.toContain('Large Cheese');
  });

  it('will not open an order the kitchen has already taken', async () => {
    const { stt, changed, all } = build({ recent: { found: false, reason: 'locked', status: 'accepted' } });
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'I just ordered, can you change it', isFinal: true });
    await waitFor(() => /already accepted/i.test(all()));
    expect(all()).toMatch(/message/i);
    expect(changed).toHaveLength(0);
  });

  it('cancels when the caller asks for it', async () => {
    const { stt, canceled, all } = build();
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'I just ordered', isFinal: true });
    await waitFor(() => /Their order #C56FB/.test(all()));

    stt.onSegment!({ text: 'I need to cancel it', isFinal: true });
    await waitFor(() => canceled.length === 1);
    expect(canceled[0]).toBe('order-1');
    expect(all()).toMatch(/canceled/i);
  });

  /** Look it up, open it, add a Coke, read it back, and try to save. */
  async function changeAndSave(stt: FakeStt, all: () => string): Promise<void> {
    stt.onSegment!({ text: 'I just ordered and I forgot something', isFinal: true });
    await waitFor(() => /Their order #C56FB/.test(all()));
    stt.onSegment!({ text: 'can you add a coke', isFinal: true });
    await waitFor(() => /open for changes/.test(all()));
    stt.onSegment!({ text: 'a coke please', isFinal: true });
    await waitFor(() => /Added 1 Coke/.test(all()));
    stt.onSegment!({ text: "okay that's everything", isFinal: true });
    await waitFor(() => /Should I save that change\?/.test(all()));
    stt.onSegment!({ text: 'yes, save it', isFinal: true });
  }

  it('looks the order up again when it changed after it was read back', async () => {
    const { stt, changed, placed, all } = build({ refuseChange: 'order_changed' });
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);
    await changeAndSave(stt, all);
    await waitFor(() => /changed after you read it/.test(all()));
    expect(changed).toHaveLength(1);
    // The draft went with it: saying yes again must not place it as a new order.
    stt.onSegment!({ text: 'yes go ahead', isFinal: true });
    await waitFor(() => /no items on the order yet/.test(all()));
    expect(placed).toHaveLength(0);
  });

  it('tells the caller the kitchen has it when a save finds it already taken', async () => {
    const { stt, placed, all } = build({ refuseChange: 'order_locked' });
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);
    await changeAndSave(stt, all);
    await waitFor(() => /already with the kitchen/.test(all()));
    stt.onSegment!({ text: 'yes go ahead', isFinal: true });
    await waitFor(() => /no items on the order yet/.test(all()));
    expect(placed).toHaveLength(0);
  });

  it('says a cancel lost to the kitchen as the kitchen having it', async () => {
    const { stt, canceled, all } = build({ refuseCancel: 'order_locked' });
    await engine!.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'I just ordered', isFinal: true });
    await waitFor(() => /Their order #C56FB/.test(all()));
    stt.onSegment!({ text: 'I need to cancel it', isFinal: true });
    await waitFor(() => /cannot be canceled now/.test(all()));
    expect(canceled).toHaveLength(1);
  });
});
