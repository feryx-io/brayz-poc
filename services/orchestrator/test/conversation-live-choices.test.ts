import { readFileSync } from 'node:fs';
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
import { ConversationEngine, type MenuItemInfo, type OrderLine } from '../src/conversation.js';

/**
 * Two sauces on wings that take one, through the real model.
 *
 * The call of 2026-09-14 16:46: "Wings." / "Half barbecue, half garlic parm."
 * The bot answered "I can do that" and confirmed half-and-half sauces on an
 * item whose Sauce group is single-choice with no halves. The menu it was
 * given said "Sauce (required)" and nothing about one. The tool now refuses
 * (conversation-choice-limits.test.ts); what only the model can show is that
 * it does not promise the combination first. Skips without ANTHROPIC_API_KEY.
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

const opts = (names: string[]) =>
  names.map((name) => ({ id: `m-${name.toLowerCase().replace(/\W+/g, '-')}`, name, priceCents: 0 }));
const SAUCES = opts([
  'Ace (Sweet Teriyaki)', 'BBQ', 'Buffalo (Hot)', 'Buffalo (Medium)', 'Buffalo (Mild)',
  'Garlic Parmesan', 'Lemon Pepper', 'Mango Habanero', 'Sweet Thai Chili',
]);
/** Saratoga's wings as they are on dev. */
const MENU: MenuItemInfo[] = [
  {
    id: 'mi-wings',
    name: 'Wings',
    category: 'Wings',
    priceCents: 1650,
    modifierGroups: [
      { id: 'g-sauce', name: 'Sauce', selectionType: 'single', required: true, minSelections: 1, maxSelections: 1, modifiers: SAUCES },
      { id: 'g-dip', name: 'Dip', selectionType: 'single', required: true, modifiers: opts(['Blue Cheese', 'Ranch']) },
    ],
  },
  {
    id: 'mi-boneless',
    name: 'Boneless Wings',
    category: 'Wings',
    priceCents: 1250,
    modifierGroups: [
      { id: 'g-sauce-b', name: 'Sauce', selectionType: 'single', required: true, minSelections: 1, maxSelections: 1, modifiers: SAUCES },
      { id: 'g-dip-b', name: 'Dip', selectionType: 'single', required: true, modifiers: opts(['Blue Cheese', 'Ranch']) },
    ],
  },
  { id: 'mi-large', name: 'Large Pizza (18")', category: 'Create Your Own Pizza', priceCents: 1900 },
];

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Words a price is said in without "dollars": "eight twenty-five", "sixteen fifty". */
const BARE_PRICE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)[ -](oh[ -])?(five|ten|fifteen|twenty|twenty-five|thirty|forty|forty-five|fifty|sixty|seventy|seventy-five|eighty|ninety|ninety-nine|ninety-five)\b(?! (dollars|minutes|cents))/i;

interface Call {
  turns: string[][];
  placed: OrderLine[][];
}

/** One call against the location's menu: the caller answers each turn with `answer`, until placed or 12 turns. */
async function call(opening: string, answer: (said: string, run: Call) => string | null): Promise<Call> {
  const stt = new FakeStt();
  const states: string[] = [];
  const run: Call = { turns: [[]], placed: [] };
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL, thinking: 'disabled' }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-choices', sampleRate: 8000, restaurantName: "Jimmy's Pizza - Saratoga" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    // A dump of a real location's menu (the /tools/menu shape) when given:
    // an invented three-item menu can hide what a 113-item one provokes.
    loadMenu: async () => (process.env.LIVE_MENU_JSON ? JSON.parse(readFileSync(process.env.LIVE_MENU_JSON, 'utf8')) : MENU),
    loadProfile: async () => ({
      name: "Jimmy's Pizza - Saratoga",
      pickupEnabled: true,
      deliveryEnabled: true,
      deliveryFeeCents: 100,
      deliveryMinimumCents: 1000,
    }),
    loadGuest: async () => ({ isReturning: true, displayName: 'James', mode: 'full' as const }),
    placeOrder: async (_ctx, lines) => {
      run.placed.push(structuredClone(lines));
      const total = lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
      return { orderCode: 'B439C', totalCents: total, etaMinutes: 20 };
    },
    onStateChange: (st) => states.push(st),
    onTranscript: (seg, who) => {
      if (who === 'agent') run.turns.at(-1)!.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000);
  let line: string | null = opening;
  for (let turn = 0; turn < 12 && line; turn += 1) {
    run.turns.push([]);
    const mark = states.length;
    stt.onSegment!({ text: line, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'), 30_000);
    await waitFor(() => states.slice(mark).at(-1) === 'listening', 90_000);
    line = run.placed.length ? null : answer(run.turns.at(-1)!.join(' '), run);
  }
  await engine.stop();
  return run;
}

const transcript = (run: Call) => run.turns.map((t, i) => `${i}: ${t.join(' ')}`).join('\n');

describe.skipIf(!HAS_KEY)(`Conversation engine — option limits, live model (${MODEL})`, () => {
  it('does not agree to half-and-half sauces on wings that take one', { timeout: 120_000 }, async () => {
    const run = await call('Wings. Half barbecue, half garlic parm.', () => null);
    const reply = run.turns[1]!.join(' ');
    if (process.env.LIVE_PROBE) console.log('PROBE', JSON.stringify({ reply }));
    expect(reply, reply).toMatch(/one sauce|only one|just one|single sauce|pick one|choose one|one of those|which (one|sauce)|can'?t (do|split)|not able to split|boneless|traditional|dip/i);
    expect(reply, reply).not.toMatch(/half (bbq|barbecue)[^?]*half garlic[^?]*(got it|\.)/i);
  });

  it('a caller who insists on both sauces gets one, or two orders, never a note carrying both', { timeout: 300_000 }, async () => {
    // The retest of 2026-09-14 17:23, played through to the order.
    const run = await call('Wings. Half barbecue, half garlic parm.', (said) => {
      if (/go ahead|should i place|place (the|your) order/i.test(said)) return 'Yes.';
      if (/pickup or delivery/i.test(said)) return 'Pickup.';
      if (/anything else|add anything/i.test(said)) return "That's it.";
      if (/boneless|traditional/i.test(said)) return 'Traditional.';
      if (/two (separate )?orders|each (in|with)|two orders/i.test(said)) return 'Sure, two orders then.';
      if (/sauce|bbq|barbecue|garlic/i.test(said)) return 'I want both.';
      if (/dip|blue cheese|ranch/i.test(said)) return 'Blue cheese.';
      return 'Yes.';
    });
    const all = transcript(run);
    if (process.env.LIVE_PROBE) console.log('PROBE', JSON.stringify({ all, placed: run.placed }));
    for (const order of run.placed) {
      for (const line of order) {
        const sauces = (line.modifiers ?? []).filter((m) => /bbq|garlic|buffalo|teriyaki|lemon|mango|thai/i.test(m.name));
        expect(sauces.length, all).toBeLessThanOrEqual(1);
        const noted = ['bbq', 'garlic'].filter((w) => (line.specialInstructions ?? '').toLowerCase().includes(w));
        expect(noted.length + sauces.length, all).toBeLessThanOrEqual(1);
      }
    }
  });

  it('says a total in dollars and cents, not "eight twenty-five"', { timeout: 300_000 }, async () => {
    // B3 on 2026-09-14 17:26: the reply said "eight twenty-five" and the voice
    // read it once as "eight hundred twenty-five" (confirmed on the recording).
    const run = await call('A quesadilla with chicken and bacon for pickup.', (said) => {
      if (/go ahead|should i place|place (the|your) order/i.test(said)) return 'Yes.';
      if (/pickup or delivery/i.test(said)) return 'Pickup.';
      if (/anything else|add anything|something to drink/i.test(said)) return "No, that's it.";
      return "That's it.";
    });
    const all = transcript(run);
    const bare = run.turns.flat().filter((t) => BARE_PRICE.test(t));
    if (process.env.LIVE_PROBE) console.log('PROBE', JSON.stringify({ all, bare }));
    expect(run.placed.length, all).toBe(1);
    expect(bare, all).toEqual([]);
  });
});
