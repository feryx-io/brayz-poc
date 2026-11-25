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
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * The one test in this suite that talks to the real model.
 *
 * Every other conversation test drives a fake LLM, which can only check the
 * shape of what we hand the model — never whether the model obeys it. That gap
 * shipped a broken fix: the menu-section change (af90834) was written for
 * exactly the call below, its test asserted the prompt now groups items under
 * their section, it passed, and the very next real call made the same mistake.
 * The prompt was right; the model dev was running could not act on it.
 *
 * So this one goes through Anthropic for real. It needs a key and it costs a
 * fraction of a cent, so it skips without ANTHROPIC_API_KEY — CI without a key
 * runs the rest of the suite as before.
 *
 * The call it replays (2026-09-01, Jimmy's Pizza - Saratoga): "I need one large
 * cheese pizza and one large sausage pizza." Saratoga has no pizza by that name.
 * It has a Hot Subs item named "Sausage" whose description reads like an
 * instruction — "Choose cheese + sauce + add onion & green pepper" — and
 * build-your-own pizzas with a Sausage topping. The caller was asked which
 * cheese and which sauce he wanted on his pizza, twice on two different calls,
 * and the second time the bot never recovered.
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

/**
 * A pizza's topping list, shared by every build-your-own size as on the real
 * menu — all of it, in menu order. A shorter list is a materially easier test:
 * cut to six toppings, the model that fails this on the real menu passes a
 * third of the time.
 */
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

function buildYourOwn(id: string, name: string, priceCents: number): MenuItemInfo {
  return {
    id,
    name,
    category: 'Create Your Own Pizza',
    priceCents,
    description: 'Eight cut',
    modifierGroups: [
      {
        id: `${id}-toppings`,
        name: 'Toppings',
        selectionType: 'multi',
        allowsHalves: true,
        halfPricing: 'full',
        modifiers: TOPPINGS,
      },
    ],
  };
}

/**
 * Saratoga's menu, cut to the items that matter here. The collision is the whole
 * point: an item NAMED after a topping, sitting in a section that is not pizza,
 * carrying a description that reads as an instruction to the order-taker.
 */
const MENU: MenuItemInfo[] = [
  {
    id: 'mi-wings',
    name: 'Boneless Wings',
    category: 'Starters',
    priceCents: 1250,
    description: 'Boneless wings',
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: [
          'Ace (Sweet Teriyaki)', 'BBQ', 'Buffalo (Hot)', 'Buffalo (Medium)', 'Buffalo (Mild)',
          'Garlic Parmesan', 'Lemon Pepper', 'Mango Habanero', 'Sweet Thai Chili',
        ].map((name) => ({
          id: `sauce-${name.toLowerCase().replace(/\W+/g, '-')}`,
          name,
          priceCents: 0,
        })),
      },
    ],
  },
  {
    id: 'mi-chicken-parm',
    name: 'Chicken Parm',
    category: 'Hot Subs',
    priceCents: 1200,
    ingredients: ['crispy chicken', 'red sauce', 'mozzarella'],
  },
  {
    id: 'mi-sausage-sub',
    name: 'Sausage',
    category: 'Hot Subs',
    priceCents: 1200,
    description: 'Choose cheese + sauce + add onion & green pepper',
    ingredients: ['sausage', 'onion', 'green pepper'],
  },
  buildYourOwn('mi-large', 'Large Pizza (18")', 1900),
  buildYourOwn('mi-medium', 'Medium Pizza (14")', 1475),
  buildYourOwn('mi-small', 'Small Pizza (12")', 1275),
  // Two specialty pizzas that DO have sausage on them, because they are the
  // plausible wrong answers a search for "sausage pizza" turns up.
  {
    id: 'mi-carcass',
    name: 'Carcass (Large)',
    category: 'Specialty Pizza',
    priceCents: 2850,
    description: 'Red sauce base, pepperoni, sausage, ham, bacon & meatball & mozzarella',
  },
  {
    id: 'mi-da-bomb',
    name: 'Da Bomb (Large)',
    category: 'Specialty Pizza',
    priceCents: 2850,
    description: 'Garlic butter base, sausage, tomato, black olive, ricotta & mozzarella',
  },
];

interface Draft {
  name: string;
  quantity: number;
  modifiers?: { name: string; portion?: string }[];
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface PlacedOrder {
  orderCode: string;
  totalCents: number;
}

/**
 * Run the caller's side of a call through the real model and hand back what it
 * did. Several lines run as several turns on one engine — placing an order takes
 * two, because the engine reads the order back and waits to be told yes before
 * it calls place_order (rule #5).
 */
async function say(
  lines: string | string[],
  placed?: PlacedOrder,
): Promise<{ draft: Draft[]; spoken: string; placedUnder: Array<string | undefined> }> {
  const stt = new FakeStt();
  const spoken: string[] = [];
  const states: string[] = [];
  const placedUnder: Array<string | undefined> = [];
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-sausage', sampleRate: 8000, restaurantName: "Jimmy's Pizza" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    // Real model, fake API — what is under test is the engine's behaviour
    // around the model, not the API.
    placeOrder: placed
      ? async (_ctx, _lines, opts) => {
          placedUnder.push(opts.customerName);
          return placed;
        }
      : undefined,
    onStateChange: (s) => states.push(s),
    onTranscript: (seg, who) => {
      if (who === 'agent') spoken.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000, 'the greeting to finish');

  // Wait on the engine's own states, never on a quiet stretch: a turn is
  // thinking → speaking → listening, and a real model can sit in `thinking`
  // for seconds before its first token. Calling a silent gap "done" ends the
  // call while the model is still composing, and the assertions then read an
  // empty order — a green suite either way, for the wrong reason.
  for (const line of typeof lines === 'string' ? [lines] : lines) {
    const mark = states.length;
    stt.onSegment!({ text: line, isFinal: true });
    const turn = () => states.slice(mark);
    await waitFor(() => turn().includes('thinking'), 30_000, 'the turn to start');
    await waitFor(() => turn().at(-1) === 'listening', 90_000, 'the turn to finish');
  }

  await engine.stop();
  return {
    draft: (engine as unknown as { order: Draft[] }).order,
    spoken: spoken.join(' '),
    placedUnder,
  };
}

describe.skipIf(!HAS_KEY)(`Conversation engine — live model (${MODEL})`, () => {
  it(
    'builds a pizza the caller named by its topping, and never offers the sub of that name',
    { timeout: 120_000 },
    async () => {
      const { draft, spoken } = await say(
        'I need one large cheese pizza and one large sausage pizza.',
      );

      // Two pizzas, both the eighteen inch: one plain, one with Sausage on it.
      expect(draft).toHaveLength(2);
      for (const line of draft) expect(line.name).toBe('Large Pizza (18")');
      const toppings = draft.map((l) => (l.modifiers ?? []).map((m) => m.name));
      expect(toppings).toContainEqual(['Sausage']);
      // "A cheese pizza" is the plain pizza, not one with Extra Cheese on the bill.
      expect(toppings, spoken).toContainEqual([]);

      // The sandwich is never reached for, and its description — which reads as
      // an instruction — is never applied to the pizza.
      expect(draft.map((l) => l.name)).not.toContain('Sausage');
      expect(spoken).not.toMatch(/which cheese|what cheese|choose a cheese/i);
    },
  );

  it(
    'always reaches the caller with the confirmation code',
    { timeout: 180_000 },
    async () => {
      const { spoken } = await say(
        // Three turns since #61: the item goes on and the turn ends, the next
        // turn reads the order back, and only then can the caller say yes.
        [
          'One large cheese pizza for pickup, put it under James.',
          'That is everything.',
          'Yes, go ahead and place it.',
        ],
        { orderCode: 'DDB37', totalCents: 1900 },
      );

      // The tool result asks the model to read the code back and it usually
      // does — but only usually: over eighteen live turns it dropped about one
      // in ten, which is how the call of 2026-09-01 ended with the caller
      // asking for it. The engine now says it when the reply does not, so this
      // holds whichever way the model goes.
      expect(spoken.replace(/[^A-Za-z0-9]/g, '').toUpperCase(), spoken).toContain('DDB37');
    },
  );

  it(
    'splits a half-and-half pizza the way the caller said it',
    { timeout: 120_000 },
    async () => {
      // The call of 2026-09-04 16:48: "half pepperoni, half sausage", and the
      // model announced on its own that toppings go on the whole pizza.
      const { draft, spoken } = await say('One large pizza, half pepperoni and half sausage.');

      expect(draft, spoken).toHaveLength(1);
      const line = draft[0]!;
      expect(line.name).toBe('Large Pizza (18")');
      const halves = (line.modifiers ?? []).map((m) => [m.name, m.portion]).sort();
      expect(halves, spoken).toEqual([
        ['Pepperoni', 'left'],
        ['Sausage', 'right'],
      ]);
      expect(spoken).not.toMatch(/whole pizza|rather than by half|all over/i);
    },
  );

  it(
    'asks a first-time caller for a name before reading the order back',
    { timeout: 240_000 },
    async () => {
      // The call of 2026-09-04 16:48: done ordering, no name offered, and the
      // model went straight to the read-back and placed it nameless. The tools
      // now refuse until there is a name; what is under test here is that the
      // real model, refused, asks for one rather than doing something else.
      const { spoken, placedUnder } = await say(
        ['One large cheese pizza for pickup, and that is everything.', 'Jim.', 'Yes.'],
        { orderCode: 'A37C8', totalCents: 1900 },
      );

      expect(spoken, spoken).toMatch(/name/i);
      expect(spoken, spoken).toMatch(/under (the name )?Jim/i);
      expect(placedUnder, spoken).toEqual(['Jim']);
    },
  );
});
