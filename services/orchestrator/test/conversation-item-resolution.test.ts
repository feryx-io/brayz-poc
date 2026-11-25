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
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * Resolving what the caller named to what the menu sells.
 *
 * This menu has no "sausage pizza". It has a Hot Subs item called "Sausage"
 * and build-your-own pizzas with a Sausage topping — and substring matching
 * answered "sausage pizza" with the sub, as one confident match, so the caller
 * got a sandwich (2026-08-31). The prompt has carried the reasoning ever since;
 * these hold it in the tool instead.
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

/** Calls add_item with whatever the caller said, then relays the tool's answer. */
class AddItemLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'tool') {
      opts.onEvent({ type: 'text', textDelta: last.content });
    } else {
      const said = [...opts.messages].reverse().find((m) => m.role === 'user')!.content;
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: 'a1', name: 'add_item', arguments: { item: said } },
      });
    }
    opts.onEvent({ type: 'done' });
  }
}

const TOPPINGS = {
  id: 'g-top',
  name: 'Toppings',
  selectionType: 'multi' as const,
  modifiers: [
    { id: 'm-saus', name: 'Sausage', priceCents: 150 },
    { id: 'm-pep', name: 'Pepperoni', priceCents: 150 },
  ],
};

const MENU: MenuItemInfo[] = [
  { id: 'mi-lg', name: 'Large Pizza (18")', category: 'Create Your Own Pizza', priceCents: 1900, modifierGroups: [TOPPINGS] },
  { id: 'mi-md', name: 'Medium Pizza (14")', category: 'Create Your Own Pizza', priceCents: 1600, modifierGroups: [TOPPINGS] },
  { id: 'mi-sm', name: 'Small Pizza (12")', category: 'Create Your Own Pizza', priceCents: 1275, modifierGroups: [TOPPINGS] },
  { id: 'mi-bbq', name: 'BBQ Chicken Pizza (Large)', category: 'Specialty Pizza', priceCents: 2400 },
  { id: 'mi-sub', name: 'Sausage', category: 'Hot Subs', priceCents: 1200 },
  {
    id: 'mi-wings',
    name: 'Boneless Wings',
    category: 'Sides',
    priceCents: 1250,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: [
          { id: 'm-bbq', name: 'BBQ', priceCents: 0 },
          { id: 'm-buf', name: 'Buffalo (Hot)', priceCents: 0 },
        ],
      },
    ],
  },
];

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** What the tool says back when the caller asks for `said`. */
async function askFor(said: string, menu: MenuItemInfo[] = MENU): Promise<string> {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const engine = new ConversationEngine({
    providers: { stt, llm: new AddItemLlm(), tts },
    context: { callId: 'call-resolve', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => menu,
    // Asserts on what the tool says back to the model, which only reaches the
    // caller when the location has asked the AI to word confirmations.
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
  });
  await engine.start();
  await waitFor(() => stt.onSegment !== undefined);
  const before = tts.spoken.length;
  stt.onSegment!({ text: said, isFinal: true });
  await waitFor(() => tts.spoken.length > before);
  await engine.stop();
  return tts.spoken.slice(before).join(' ');
}

describe('Conversation engine — resolving an item the caller named', () => {
  it('does not answer "sausage pizza" with the sausage sub', async () => {
    const said = await askFor('sausage pizza');
    expect(said).not.toMatch(/\$12\.00/); // the sub's price
    expect(said).toMatch(/Large Pizza|Medium Pizza|Small Pizza/);
    // Asked which size, and the topping that prompted the question survives it.
    expect(said).toMatch(/Sausage/);
  }, 15_000);

  it('resolves a size and a topping named together, and prices both', async () => {
    const said = await askFor('large sausage pizza');
    expect(said).toContain('Large Pizza (18")');
    expect(said).toContain('Sausage');
    expect(said).toMatch(/\$20\.50/); // $19.00 + $1.50 topping
  }, 15_000);

  it('still gives the sub to someone who asks for it by name', async () => {
    expect(await askFor('Sausage')).toMatch(/\$12\.00/);
    expect(await askFor('sausage sub')).toMatch(/\$12\.00/);
  }, 15_000);

  it('keeps a specialty pizza that is genuinely named on the menu', async () => {
    const said = await askFor('bbq chicken pizza');
    expect(said).toContain('BBQ Chicken Pizza (Large)');
    expect(said).toMatch(/\$24\.00/);
  }, 15_000);

  it('says an item is not on the menu rather than inventing a match', async () => {
    expect(await askFor('lobster roll')).toMatch(/not on the menu/i);
  }, 15_000);

  it('does not turn a required choice into a topping it was never offered', async () => {
    // "wings" names a section word only through the item's own name; the sauce
    // is a required choice the caller has not made yet.
    const said = await askFor('boneless wings');
    expect(said).toContain('Boneless Wings');
    expect(said).not.toMatch(/with (BBQ|Buffalo)/);
  }, 15_000);

  it('behaves as before on a menu with no sections at all', async () => {
    const flat: MenuItemInfo[] = [{ id: 'x', name: 'Garlic Knots', priceCents: 599 }];
    expect(await askFor('garlic knots', flat)).toContain('Garlic Knots');
    expect(await askFor('lobster roll', flat)).toMatch(/not on the menu/i);
  }, 15_000);
});
