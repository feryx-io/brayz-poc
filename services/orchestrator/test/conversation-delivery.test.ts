import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmMessage,
  LlmProvider,
  LlmStreamEvent,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import type { DeliveryAddress } from '@brayz/shared';
import {
  ConversationEngine,
  type DeliveryCheck,
  type GuestInfo,
  type MenuItemInfo,
  type OrderLine,
  type SavedAddressCheck,
} from '../src/conversation.js';

/**
 * Pickup or delivery, and where it goes.
 *
 * A restaurant that does both is asked about on every order ("Is this for
 * pickup or delivery?"), and the read-back will not happen until it is known —
 * the same tool-enforced gate as the name. A delivery needs an address the API
 * has checked against the delivery area; the read-back carries the address and
 * the fee. A regular's saved address is offered back in full memory mode, and
 * in confirm mode it is not said — not even known to the engine — until the
 * caller gives its street number (rule #6).
 */
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

interface Step {
  text?: string;
  tools?: Array<{ name: string; arguments?: Record<string, unknown> }>;
}

/** Says exactly what the script says, one entry per request the engine makes. */
class ScriptedLlm implements LlmProvider {
  readonly name = 'fake-llm';
  script: Step[] = [];
  requests = 0;
  toolResults: string[] = [];
  systemMessages: string[] = [];

  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.toolResults = opts.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    this.systemMessages = opts.messages.filter((m) => m.role === 'system').map((m) => m.content);
    const step = this.script[this.requests] ?? {};
    this.requests += 1;
    if (step.text) opts.onEvent({ type: 'text', textDelta: step.text });
    for (const [i, t] of (step.tools ?? []).entries()) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: `t${this.requests}-${i}`, name: t.name, arguments: t.arguments ?? {} },
      });
    }
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [{ id: 'mi-1', name: 'Large Pepperoni', priceCents: 1800 }];
const HOME: DeliveryAddress = { line1: '12 Main Street', postalCode: '12866' };

/** A restaurant that does both, with a $2.99 fee. */
const BOTH = {
  pickupEnabled: true,
  deliveryEnabled: true,
  pickupEtaMinutes: 20,
  deliveryEtaMinutes: 45,
  deliveryFeeCents: 299,
  deliveryMinimumCents: 0,
};

function inArea(overrides: Partial<DeliveryCheck> = {}): DeliveryCheck {
  return { deliverable: true, check: 'in_zip', feeCents: 299, minimumCents: 0, etaMinutes: 45, ...overrides };
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Setup {
  profile?: Record<string, unknown>;
  guest?: GuestInfo;
  check?: (address: DeliveryAddress) => DeliveryCheck | null;
  confirm?: (streetNumber: string) => SavedAddressCheck | null;
}

function buildEngine(setup: Setup = {}) {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const tts = new FakeTts();
  const placed: Array<{ lines: OrderLine[]; opts: Record<string, unknown> }> = [];
  const checked: DeliveryAddress[] = [];
  const confirmed: string[] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-delivery', sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({ orderAckMode: 'natural' as const, ...setup.profile }),
    loadGuest: setup.guest ? async () => setup.guest! : undefined,
    checkDelivery: async (_ctx, address) => {
      checked.push(address);
      return setup.check ? setup.check(address) : inArea();
    },
    confirmSavedAddress: async (_ctx, streetNumber) => {
      confirmed.push(streetNumber);
      return setup.confirm ? setup.confirm(streetNumber) : { confirmed: false, reason: 'mismatch', attemptsLeft: 1 };
    },
    placeOrder: async (_ctx, lines, opts) => {
      placed.push({ lines, opts });
      const delivery = opts.fulfillmentType === 'delivery';
      return {
        orderCode: 'ABCDE',
        totalCents: delivery ? 2099 : 1800,
        deliveryFeeCents: delivery ? 299 : 0,
        etaMinutes: delivery ? 45 : 25,
      };
    },
  });
  const say = async (text: string, requests: number) => {
    stt.onSegment!({ text, isFinal: true });
    await waitFor(() => llm.requests === requests);
  };
  /** Everything the model has been told so far — system context and tool results. */
  const told = () => [...llm.systemMessages, ...llm.toolResults].join('\n');
  return { engine, stt, llm, tts, placed, checked, confirmed, say, told };
}

/** The steps that get one pepperoni onto the order. */
const ADD: Step[] = [
  { tools: [{ name: 'add_item', arguments: { item: 'Large Pepperoni' } }] },
  { text: 'Added a large pepperoni.' },
];

describe('Conversation engine — pickup or delivery', () => {
  it('asks pickup or delivery, takes the address, and reads back where it goes and the fee', async () => {
    const { engine, stt, llm, placed, checked, say } = buildEngine({ profile: BOTH });
    llm.script = [
      ...ADD,
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'Is this for pickup or delivery?' },
      { tools: [{ name: 'set_fulfillment', arguments: { type: 'delivery' } }] },
      { text: "What's the address for delivery?" },
      {
        tools: [
          { name: 'set_delivery_address', arguments: { line1: '12 Main Street', postal_code: '12866' } },
          { name: 'review_order' },
        ],
      },
      { text: 'Should I go ahead and place the order for delivery under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'All set.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say("that's all, it's for Jim", 4);
    // Refused, and told exactly what to ask.
    expect(llm.toolResults.at(-1)).toMatch(/Is this for pickup or delivery\?/);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);

    await say('delivery', 6);
    expect(llm.toolResults.at(-1)).toMatch(/Ask for the delivery address/);

    await say('12 Main Street, 12866', 8);
    expect(checked[0]).toMatchObject({ line1: '12 Main Street', postalCode: '12866' });
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    expect(readBack).toContain('Delivery fee $2.99');
    expect(readBack).toContain('Total $20.99');
    expect(readBack).toContain('For delivery to 12 Main Street, 12866');
    expect(readBack).toContain('Should I go ahead and place the order for delivery under Jim?');
    expect(placed).toHaveLength(0);

    await say('yes', 10);
    expect(placed[0]!.opts).toMatchObject({
      customerName: 'Jim',
      fulfillmentType: 'delivery',
      deliveryAddress: { line1: '12 Main Street', postalCode: '12866' },
    });
    // The location's delivery time, not the old fixed pickup line.
    expect(llm.toolResults.at(-1)).toMatch(/delivered in about 45 minutes/);
    await engine.stop();
  }, 15_000);

  it('a pickup-only restaurant never asks, refuses delivery, and reads back as it always has', async () => {
    const { engine, stt, llm, placed, say } = buildEngine({
      profile: { pickupEnabled: true, deliveryEnabled: false, pickupEtaMinutes: 25 },
    });
    llm.script = [
      ...ADD,
      {
        tools: [
          { name: 'set_fulfillment', arguments: { type: 'delivery' } },
          { name: 'review_order', arguments: { customer_name: 'Jim' } },
        ],
      },
      { text: 'Should I go ahead and place the order under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'Done.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say('can you deliver it? the name is Jim', 4);
    expect(llm.toolResults.some((r) => /does not deliver/.test(r))).toBe(true);
    expect(llm.systemMessages.join('\n')).toMatch(/pickup only/i);
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    expect(readBack).toContain('Should I go ahead and place the order under Jim?');
    expect(readBack).not.toMatch(/deliver/i);

    await say('yes', 6);
    expect(placed[0]!.opts.fulfillmentType).toBe('pickup');
    expect(placed[0]!.opts.deliveryAddress).toBeUndefined();
    expect(llm.toolResults.at(-1)).toMatch(/ready for pickup in about 25 minutes/);
    await engine.stop();
  }, 15_000);

  it('offers a full-memory regular their saved address back', async () => {
    const guest: GuestInfo = {
      isReturning: true,
      displayName: 'Mike',
      mode: 'full',
      hasSavedAddress: true,
      savedAddress: { line1: '12 Main Street', line2: 'Apt 2', postalCode: '12866' },
    };
    const { engine, stt, llm, checked, say } = buildEngine({ profile: BOTH, guest });
    llm.script = [
      ...ADD,
      { tools: [{ name: 'set_fulfillment', arguments: { type: 'delivery' } }] },
      { text: 'Are we still delivering to 12 Main Street, Apt 2, or someplace else?' },
      { tools: [{ name: 'use_saved_address' }, { name: 'review_order' }] },
      { text: 'Should I go ahead and place the order for delivery under Mike?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say('for delivery', 4);
    expect(llm.toolResults.at(-1)).toContain(
      '"Are we still delivering to 12 Main Street, Apt 2, or someplace else?"',
    );

    await say('yes, same place', 6);
    // Still checked against the area: it may have changed since last time.
    expect(checked[0]).toMatchObject({ line1: '12 Main Street', line2: 'Apt 2' });
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    expect(readBack).toContain('For delivery to 12 Main Street, Apt 2, 12866');
    expect(readBack).toContain('under Mike?');
    await engine.stop();
  }, 15_000);

  it('in confirm mode, never says the saved address until the caller gives its street number', async () => {
    const guest: GuestInfo = {
      isReturning: true,
      displayName: 'Mike',
      mode: 'confirm',
      hasSavedAddress: true,
      // The API withholds it in confirm mode; the engine must not use it even if it arrived.
      savedAddress: HOME,
    };
    const { engine, stt, llm, confirmed, say, told } = buildEngine({
      profile: BOTH,
      guest,
      confirm: (n) =>
        n === '12' ? { confirmed: true, address: HOME } : { confirmed: false, reason: 'mismatch', attemptsLeft: 1 },
    });
    llm.script = [
      ...ADD,
      {
        tools: [
          { name: 'set_fulfillment', arguments: { type: 'delivery' } },
          { name: 'use_saved_address' },
        ],
      },
      { text: 'Can you confirm the street number on your usual delivery address?' },
      { tools: [{ name: 'confirm_saved_address', arguments: { street_number: '14' } }] },
      { text: "That doesn't match — could you try once more?" },
      {
        tools: [
          { name: 'confirm_saved_address', arguments: { street_number: '12' } },
          { name: 'review_order', arguments: { customer_name: 'Mike' } },
        ],
      },
      { text: 'Should I go ahead and place the order for delivery under Mike?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say('delivery please', 4);
    expect(told()).toMatch(/Can you confirm the street number on your usual delivery address\?/);
    expect(llm.toolResults.at(-1)).toMatch(/has not been confirmed/);
    expect(told()).not.toMatch(/Main Street/);

    await say('fourteen', 6);
    expect(confirmed).toEqual(['14']);
    expect(llm.toolResults.at(-1)).toMatch(/does not match/);
    expect(told()).not.toMatch(/Main Street/);

    await say('sorry, twelve', 8);
    expect(confirmed).toEqual(['14', '12']);
    const readBack = llm.toolResults.find((r) => /Current order:/.test(r))!;
    expect(readBack).toContain('For delivery to 12 Main Street, 12866');
    await engine.stop();
  }, 15_000);

  it('keeps the address out of the logs, arguments and results alike', async () => {
    // The first call after the tool logging shipped (2026-09-11 23:07) put a
    // guest's home address into Cloud Logging three times over: the arguments
    // were redacted by key, the results were not, and a result quotes the
    // address back ("Delivering to 15 Cook Circle…").
    const written: string[] = [];
    const guest: GuestInfo = {
      isReturning: true,
      displayName: 'Mike',
      mode: 'full',
      hasSavedAddress: true,
      savedAddress: { line1: '12 Main Street', line2: 'Apt 2', postalCode: '12866' },
    };
    const stt = new FakeStt();
    const llm = new ScriptedLlm();
    const engine = new ConversationEngine({
      providers: { stt, llm, tts: new FakeTts() },
      context: { callId: 'call-redaction', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'info' }, { write: (line: string) => written.push(line) }),
      loadMenu: async () => MENU,
      loadProfile: async () => ({ orderAckMode: 'natural' as const, ...BOTH }),
      loadGuest: async () => guest,
      checkDelivery: async () => inArea(),
      placeOrder: async () => ({ orderCode: 'ABCDE', totalCents: 2099 }),
    });
    llm.script = [
      ...ADD,
      { tools: [{ name: 'set_fulfillment', arguments: { type: 'delivery' } }] },
      { text: 'Are we still delivering to 12 Main Street, Apt 2?' },
      {
        tools: [
          { name: 'set_delivery_address', arguments: { line1: '9 Elm Street', postal_code: '12866' } },
          { name: 'review_order' },
        ],
      },
      { text: 'Should I go ahead and place the order for delivery under Mike?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => llm.requests === 2);
    stt.onSegment!({ text: 'for delivery', isFinal: true });
    await waitFor(() => llm.requests === 4);
    stt.onSegment!({ text: '9 Elm Street, 12866', isFinal: true });
    await waitFor(() => llm.requests === 6);

    const logs = written.join('\n');
    // The tools were logged at all — otherwise this test proves nothing.
    expect(logs).toMatch(/"msg":"order tool"/);
    expect(logs).toMatch(/set_fulfillment/);
    expect(logs).toMatch(/review_order/);
    // And neither address is in them: not the saved one the result quoted back,
    // not the new one the caller gave as an argument.
    expect(logs).not.toMatch(/12 Main Street/);
    expect(logs).not.toMatch(/9 Elm Street/);
    expect(logs).toMatch(/\[address\]|\[given\]/);
    await engine.stop();
  }, 15_000);

  it('refuses an address outside the delivery area, and the order waits for another', async () => {
    const { engine, stt, llm, placed, say } = buildEngine({
      profile: BOTH,
      check: () => inArea({ deliverable: false, check: 'outside', distanceMiles: 9.2, radiusMiles: 5 }),
    });
    llm.script = [
      ...ADD,
      {
        tools: [
          { name: 'set_fulfillment', arguments: { type: 'delivery' } },
          { name: 'set_delivery_address', arguments: { line1: '99 Far Road' } },
          { name: 'review_order', arguments: { customer_name: 'Jim' } },
        ],
      },
      { text: "Sorry, that's outside our delivery area." },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say('deliver it to 99 Far Road, for Jim', 4);
    expect(
      llm.toolResults.some((r) =>
        /outside the delivery area\. It is about 9\.2 miles away, and delivery goes up to 5 miles/.test(r),
      ),
    ).toBe(true);
    expect(llm.toolResults.at(-1)).toMatch(/no delivery address/);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);
    expect(placed).toHaveLength(0);
    await engine.stop();
  }, 15_000);

  it('holds a delivery that is short of the minimum', async () => {
    const { engine, stt, llm, say } = buildEngine({
      profile: { ...BOTH, deliveryMinimumCents: 2000 },
      check: () => inArea({ minimumCents: 2000 }),
    });
    llm.script = [
      ...ADD,
      {
        tools: [
          { name: 'set_fulfillment', arguments: { type: 'delivery' } },
          { name: 'set_delivery_address', arguments: { line1: '12 Main Street', postal_code: '12866' } },
          { name: 'review_order', arguments: { customer_name: 'Jim' } },
        ],
      },
      { text: 'Delivery has a twenty dollar minimum.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    await say('one large pepperoni', 2);
    await say('delivery to 12 Main Street, for Jim', 4);
    expect(llm.toolResults.some((r) => /Delivery needs at least \$20\.00 of food/.test(r))).toBe(true);
    expect(llm.toolResults.at(-1)).toMatch(/at least \$20\.00 of food before the delivery fee, and this one is \$18\.00/);
    expect(llm.toolResults.some((r) => /Current order:/.test(r))).toBe(false);
    await engine.stop();
  }, 15_000);
});
