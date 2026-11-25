import { describe, expect, it } from 'vitest';
import pino from 'pino';
import {
  AnthropicLlmProvider,
  type AudioFrame,
  type SpeechToTextProvider,
  type SttStreamHandle,
  type TextToSpeechProvider,
  type TranscriptSegment,
} from '@brayz/ai';
import type { DeliveryAddress } from '@brayz/shared';
import {
  ConversationEngine,
  type GuestInfo,
  type MenuItemInfo,
  type SavedAddressCheck,
} from '../src/conversation.js';

/**
 * Delivery, through the real model.
 *
 * conversation-delivery.test.ts proves the tools: the read-back waits for
 * "pickup or delivery", a delivery waits for an address the area check
 * passed, and confirm mode never hands the engine the address before the
 * street number matches. What only the model can show is that it follows the
 * prompt around those tools — asks the question at all, passes the address
 * the caller said to set_delivery_address, offers a regular's saved address
 * back, and in confirm mode asks for the street number rather than guessing.
 * (Why a live test at all: see conversation-live.test.ts.)
 *
 * The caller adapts to what they are asked, the way a person does, so a model
 * that asks for the name before the address — both are fine — is not failed
 * for the order it chose. Skips without ANTHROPIC_API_KEY.
 */
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5';

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
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    opts.onAudio(new Uint8Array(320));
  }
}

/** Saratoga's pizza, with its whole topping list, plus two starters to be upsold. */
const TOPPINGS = [
  'Anchovies:300', 'Artichoke:150', 'Bacon:150', 'Banana Pepper:150', 'Basil:150',
  'Black Olives:150', 'Broccoli:150', 'Chicken:300', 'Eggplant:300', 'Extra Cheese:300',
  'Garlic:150', 'Green Olives:150', 'Green Pepper:150', 'Ham:150', 'Hamburger:150',
  'Hot Cherry Peppers:150', 'Kielbasa:300', 'Meatball:150', 'Mushroom:150', 'Onion:150',
  'Pepperoni:150', 'Pineapple:150', 'Roasted Red Pepper:150', 'Salami:150', 'Sausage:150',
  'Spinach:150', 'Tomato:150',
].map((entry) => {
  const [name, cents] = entry.split(':') as [string, string];
  return { id: `top-${name.toLowerCase().replace(/\W+/g, '-')}`, name, priceCents: Number(cents) };
});

const MENU: MenuItemInfo[] = [
  {
    id: 'mi-large',
    name: 'Large Pizza (18")',
    category: 'Create Your Own Pizza',
    priceCents: 1900,
    description: 'Eight cut',
    modifierGroups: [
      { id: 'g-top', name: 'Toppings', selectionType: 'multi', allowsHalves: true, halfPricing: 'full', modifiers: TOPPINGS },
    ],
  },
  {
    id: 'mi-wings',
    name: 'Boneless Wings',
    category: 'Starters',
    priceCents: 1250,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: ['BBQ', 'Buffalo (Hot)', 'Buffalo (Mild)', 'Garlic Parmesan'].map((name) => ({
          id: `sauce-${name.toLowerCase().replace(/\W+/g, '-')}`,
          name,
          priceCents: 0,
        })),
      },
    ],
  },
  { id: 'mi-knots', name: 'Garlic Knots', category: 'Starters', priceCents: 599 },
];

const HOME: DeliveryAddress = { line1: '12 Main Street', postalCode: '12866' };

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Run {
  /** Every agent line, in order, greeting included. */
  spoken: string[];
  placed: Array<Record<string, unknown>>;
  checked: DeliveryAddress[];
  /** Street numbers passed to confirm_saved_address, with how much had been spoken by then. */
  confirmed: Array<{ number: string; spokenBefore: number }>;
}

/**
 * One call. The caller opens with `opening`, then answers whatever the last
 * turn asked (`answer`), until the order is placed or eight turns pass.
 */
async function call(
  opening: string,
  answer: (said: string) => string,
  setup: { guest?: GuestInfo; confirm?: (n: string) => SavedAddressCheck } = {},
): Promise<Run> {
  const stt = new FakeStt();
  const states: string[] = [];
  const run: Run = { spoken: [], placed: [], checked: [], confirmed: [] };
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-delivery', sampleRate: 8000, restaurantName: "Jimmy's Pizza" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => ({
      name: "Jimmy's Pizza",
      pickupEnabled: true,
      deliveryEnabled: true,
      pickupEtaMinutes: 20,
      deliveryEtaMinutes: 45,
      deliveryFeeCents: 299,
      deliveryMinimumCents: 1500,
    }),
    loadGuest: setup.guest ? async () => setup.guest! : undefined,
    // Real model, fake API: what is under test is the model around the engine.
    checkDelivery: async (_ctx, address) => {
      run.checked.push(address);
      return { deliverable: true, check: 'in_zip', feeCents: 299, minimumCents: 1500, etaMinutes: 45 };
    },
    confirmSavedAddress: async (_ctx, number) => {
      run.confirmed.push({ number, spokenBefore: run.spoken.length });
      return setup.confirm ? setup.confirm(number) : { confirmed: false, reason: 'no_saved_address' };
    },
    placeOrder: async (_ctx, _lines, opts) => {
      run.placed.push(opts as Record<string, unknown>);
      const delivery = opts.fulfillmentType === 'delivery';
      return { orderCode: 'DL123', totalCents: delivery ? 2349 : 2050, deliveryFeeCents: delivery ? 299 : 0, etaMinutes: delivery ? 45 : 20 };
    },
    onStateChange: (s) => states.push(s),
    onTranscript: (seg, who) => {
      if (who === 'agent') run.spoken.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000, 'the greeting to finish');

  let line = opening;
  for (let turn = 0; turn < 8 && !run.placed.length; turn += 1) {
    const mark = states.length;
    const before = run.spoken.length;
    stt.onSegment!({ text: line, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'), 30_000, 'the turn to start');
    await waitFor(() => states.slice(mark).at(-1) === 'listening', 90_000, 'the turn to finish');
    line = answer(run.spoken.slice(before).join(' '));
  }
  // The line after place_order (the code and the time) is part of the call.
  await engine.stop();
  return run;
}

/** A caller who wants delivery to 12 Main Street, under Jim, and nothing else. */
function newCaller(said: string): string {
  if (/go ahead|place (the|your|this) order|shall I|should I/i.test(said)) return 'Yes, go ahead.';
  if (/pickup or delivery|delivery or pickup/i.test(said)) return 'Delivery.';
  if (/address|where.*(deliver|send)/i.test(said)) return '12 Main Street, 12866.';
  if (/zip/i.test(said)) return '12866.';
  if (/name/i.test(said)) return 'Jim.';
  return "No thanks, that's everything.";
}

describe.skipIf(!HAS_KEY)(`Conversation engine — delivery, live model (${MODEL})`, () => {
  it(
    'asks "pickup or delivery?", takes the address, and reads back where it goes and the fee',
    { timeout: 300_000 },
    async () => {
      const run = await call("Hi, can I get a large pizza with pepperoni? The name's Jim.", newCaller);
      const all = run.spoken.join(' ');

      expect(all, all).toMatch(/pickup or delivery|delivery or pickup/i);
      expect(run.checked[0]?.line1, all).toMatch(/^12 Main St/i);
      expect(run.checked[0]?.postalCode, all).toBe('12866');
      expect(run.placed, all).toHaveLength(1);
      expect(run.placed[0], all).toMatchObject({ fulfillmentType: 'delivery', customerName: 'Jim' });
      // The read-back says where it is going and what delivery costs.
      expect(all, all).toMatch(/12 Main/i);
      expect(all, all).toMatch(/2\.99|two ninety[- ]nine|two dollars? and ninety[- ]nine/i);
      // And when it will arrive — the location's time, not the old pickup line.
      expect(all, all).toMatch(/45|forty[- ]five/i);
      expect(all, all).not.toMatch(/fifteen to twenty/i);
    },
  );

  it(
    'offers a regular their saved address back, in full memory mode',
    { timeout: 300_000 },
    async () => {
      const guest: GuestInfo = {
        isReturning: true,
        displayName: 'Mike',
        mode: 'full',
        hasSavedAddress: true,
        savedAddress: HOME,
      };
      const run = await call(
        'Hi, a large pizza with pepperoni for delivery, please.',
        (said) => {
          if (/go ahead|place (the|your|this) order|shall I|should I/i.test(said)) return 'Yes, go ahead.';
          if (/12 Main|still deliver|same (address|place)|usual/i.test(said)) return 'Yes, same place.';
          return "No thanks, that's everything.";
        },
        { guest },
      );
      const all = run.spoken.join(' ');

      expect(all, all).toMatch(/12 Main Street/i);
      expect(run.placed, all).toHaveLength(1);
      expect(run.placed[0], all).toMatchObject({
        fulfillmentType: 'delivery',
        customerName: 'Mike',
        deliveryAddress: { line1: '12 Main Street' },
      });
      // Nobody was asked to read out an address the restaurant already had.
      expect(all, all).not.toMatch(/what('s| is) (the|your) address/i);
    },
  );

  it(
    'in confirm mode, asks for the street number and never says the address before it matches',
    { timeout: 300_000 },
    async () => {
      const guest: GuestInfo = { isReturning: true, displayName: 'Mike', mode: 'confirm', hasSavedAddress: true };
      const run = await call(
        "Hi, this is Mike. A large pizza with pepperoni for delivery, please. That's all.",
        (said) => {
          if (/go ahead|place (the|your|this) order|shall I|should I/i.test(said)) return 'Yes, go ahead.';
          if (/street number/i.test(said)) return '12.';
          if (/name/i.test(said)) return 'Mike.';
          if (/address/i.test(said)) return 'Yes, my usual one.';
          return "No thanks, that's everything.";
        },
        {
          guest,
          confirm: (n) =>
            /\b12\b/.test(n) ? { confirmed: true, address: HOME } : { confirmed: false, reason: 'mismatch', attemptsLeft: 1 },
        },
      );
      const all = run.spoken.join(' ');

      expect(all, all).toMatch(/street number/i);
      const first = run.confirmed[0];
      expect(first?.number, all).toMatch(/\b12\b/);
      // Everything said before the number matched is free of the address.
      expect(run.spoken.slice(0, first?.spokenBefore ?? run.spoken.length).join(' '), all).not.toMatch(/Main Street/i);
      expect(run.placed, all).toHaveLength(1);
      expect(run.placed[0], all).toMatchObject({ fulfillmentType: 'delivery', deliveryAddress: { line1: '12 Main Street' } });
    },
  );
});
