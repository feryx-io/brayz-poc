import { describe, expect, it } from 'vitest';
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

/**
 * Options on an order line. The menu has carried modifier groups since Phase 1
 * and the ordering path ignored them: a caller asking for garlic parm boneless
 * wings got those words in a free-text note, unpriced, with nothing on the
 * ticket saying which sauce to make.
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

/** Adds the wings with the caller's choices, then relays the tool's own words. */
class OrderLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'tool') {
      opts.onEvent({ type: 'text', textDelta: last.content });
      opts.onEvent({ type: 'done' });
      return;
    }
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    if (/mild/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'a2',
          name: 'add_item',
          arguments: { item: 'Boneless Wings', quantity: 1, modifiers: ['Mild'] },
        },
      });
    } else if (/barbecue|bbq/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'u2',
          name: 'update_item',
          arguments: { item: 'Boneless Wings', modifiers: ['BBQ'] },
        },
      });
    } else if (/mushroom/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'u3',
          name: 'update_item',
          arguments: { item: 'Large Pizza', modifiers: ['Mushroom'] },
        },
      });
    } else if (/pizza/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'a3',
          name: 'add_item',
          arguments: { item: 'Large Pizza', quantity: 1, modifiers: ['Pepperoni'] },
        },
      });
    } else if (/side/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'u1',
          name: 'update_item',
          arguments: { item: 'Boneless Wings', special_instructions: 'ranch on the side' },
        },
      });
    } else if (/^yes|that'?s right/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: 'p1', name: 'place_order', arguments: { customer_name: 'Dana' } },
      });
    } else if (/place|under/i.test(lastUser?.content ?? '')) {
      // Read back first: the engine refuses to place an order in the same turn
      // it was read back in, so the caller gets one to answer in.
      opts.onEvent({ type: 'tool_call', toolCall: { id: 'r1', name: 'review_order', arguments: { customer_name: 'Sam' } } });
    } else {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'a1',
          name: 'add_item',
          arguments: {
            item: 'Boneless Wings',
            quantity: 2,
            // The last one is not on this item — the caller asked for it anyway,
            // which is what callers do.
            modifiers: ['Garlic Parm', 'Boneless', 'ranch dip'],
          },
        },
      });
    }
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [
  {
    id: 'mi-wings',
    name: 'Boneless Wings',
    priceCents: 1250,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        // One sauce, which is the whole point of the replacement below.
        selectionType: 'single',
        required: true,
        modifiers: [
          { id: 'm-mild', name: 'Mild', priceCents: 0 },
          { id: 'm-gp', name: 'Garlic Parm', priceCents: 125 },
          { id: 'm-bbq', name: 'BBQ', priceCents: 0 },
        ],
      },
      {
        id: 'g-style',
        name: 'Style',
        modifiers: [{ id: 'm-bone', name: 'Boneless', priceCents: 0 }],
      },
    ],
  },
  {
    id: 'mi-pizza',
    name: 'Large Pizza',
    priceCents: 1900,
    modifierGroups: [
      {
        id: 'g-top',
        name: 'Toppings',
        // As many as they like — "and mushrooms" adds, never replaces.
        selectionType: 'multi',
        modifiers: [
          { id: 'm-pep', name: 'Pepperoni', priceCents: 150 },
          { id: 'm-mush', name: 'Mushroom', priceCents: 150 },
        ],
      },
    ],
  },
];

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** An engine wired to MENU, with somewhere to catch the placed order. */
function buildOrderEngine(callId: string) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const placed: { lines?: OrderLine[] } = {};
  const engine = new ConversationEngine({
    providers: { stt, llm: new OrderLlm(), tts },
    context: { callId, sampleRate: 8000, restaurantName: "Mario's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    // Asserts on what the tool says back to the model, which only reaches the
    // caller when the location has asked the AI to word confirmations.
    loadProfile: async () => ({ orderAckMode: 'natural' as const }),
    placeOrder: async (_ctx, lines) => {
      placed.lines = lines;
      return { orderCode: 'ABCDE', totalCents: 0 };
    },
  });
  return { engine, stt, tts, placed };
}

describe('Conversation engine — order line options', () => {
  it('prices the options from the menu and sends their ids to the API', async () => {
    const stt = new FakeStt();
    const tts = new FakeTts();
    let placed: { lines: OrderLine[] } | undefined;
    const engine = new ConversationEngine({
      providers: { stt, llm: new OrderLlm(), tts },
      context: { callId: 'call-mods', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => MENU,
      // Asserts on what the tool says back to the model, which only reaches the
      // caller when the location has asked the AI to word confirmations.
      loadProfile: async () => ({ orderAckMode: 'natural' as const }),
      placeOrder: async (_ctx, lines) => {
        placed = { lines };
        return { orderCode: 'ABCDE', totalCents: 2750 };
      },
    });

    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'two garlic parm boneless wings please', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));

    const said = tts.spoken.join(' ');
    // Two wings at $12.50 plus $1.25 of garlic parm each.
    expect(said).toMatch(/\$27\.50/);
    expect(said).toContain('Garlic Parm');
    // The option this item does not have is said out loud rather than dropped.
    expect(said).toContain('ranch dip');
    expect(said).toContain('special request');

    stt.onSegment!({ text: 'place it under Dana', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: "yes that's right", isFinal: true });
    await waitFor(() => placed !== undefined);
    expect(placed!.lines).toHaveLength(1);
    // Ids, so the API prices them itself (rule #5) — and no duplicate of an
    // option named twice.
    expect(placed!.lines[0]!.modifiers).toEqual([
      { id: 'm-gp', name: 'Garlic Parm', priceCents: 125 },
      { id: 'm-bone', name: 'Boneless', priceCents: 0 },
    ]);
    // And what the menu could not price still reaches the kitchen.
    expect(placed!.lines[0]!.specialInstructions).toContain('ranch dip');
    await engine.stop();
  }, 15_000);

  it('puts a later request on the item it is for, not in a note to staff', async () => {
    // The live failure this exists for (2026-08-31): the caller asked for ranch
    // on the side after the wings were already added. special_instructions can
    // only be set by add_item, so the model reached for create_call_note — which
    // files a message for staff and leaves the kitchen ticket saying nothing
    // about ranch.
    const stt = new FakeStt();
    const tts = new FakeTts();
    let placed: { lines: OrderLine[] } | undefined;
    const engine = new ConversationEngine({
      providers: { stt, llm: new OrderLlm(), tts },
      context: { callId: 'call-mods-3', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      loadMenu: async () => MENU,
      // Asserts on what the tool says back to the model, which only reaches the
      // caller when the location has asked the AI to word confirmations.
      loadProfile: async () => ({ orderAckMode: 'natural' as const }),
      placeOrder: async (_ctx, lines) => {
        placed = { lines };
        return { orderCode: 'ABCDE', totalCents: 2750 };
      },
    });

    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'two garlic parm boneless wings please', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));

    stt.onSegment!({ text: 'and ranch on the side', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Updated Boneless Wings/i.test(s)));

    stt.onSegment!({ text: 'place it under Dana', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: "yes that's right", isFinal: true });
    await waitFor(() => placed !== undefined);

    const line = placed!.lines[0]!;
    expect(placed!.lines).toHaveLength(1); // amended, not added a second time
    expect(line.specialInstructions).toContain('ranch on the side');
    // What was already noted on the line survives the update.
    expect(line.specialInstructions).toContain('ranch dip');
    expect(line.modifiers).toHaveLength(2);
    await engine.stop();
  }, 15_000);

  it('swaps the sauce instead of stacking a second one on the same wings', async () => {
    // The live failure (2026-08-31): the bot chose Buffalo (Medium) by itself,
    // the caller asked for BBQ "instead of buffalo", and the ticket reached the
    // kitchen carrying both sauces while the bot said it had switched them.
    const { engine, stt, tts, placed } = buildOrderEngine('call-mods-4');
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'boneless wings with mild sauce', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));

    stt.onSegment!({ text: 'actually make that barbecue instead', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Updated Boneless Wings/i.test(s)));

    stt.onSegment!({ text: 'place it under Dana', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: "yes that's right", isFinal: true });
    await waitFor(() => placed.lines !== undefined);

    // One sauce, and it is the one they asked for.
    expect(placed.lines![0]!.modifiers).toEqual([{ id: 'm-bbq', name: 'BBQ', priceCents: 0 }]);
    // And the caller is told what happened, so the bot cannot claim a switch
    // that did not occur.
    expect(tts.spoken.join(' ')).toContain('Removed Mild');
    await engine.stop();
  }, 15_000);

  it('adds a second topping rather than replacing the first', async () => {
    const { engine, stt, tts, placed } = buildOrderEngine('call-mods-5');
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'a large pizza with pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));

    stt.onSegment!({ text: 'and mushrooms too', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Updated Large Pizza/i.test(s)));

    stt.onSegment!({ text: 'place it under Dana', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: "yes that's right", isFinal: true });
    await waitFor(() => placed.lines !== undefined);

    // Toppings are a multi-select group: "and mushrooms" means both.
    expect(placed.lines![0]!.modifiers?.map((m) => m.name)).toEqual(['Pepperoni', 'Mushroom']);
    expect(placed.lines![0]!.unitPriceCents).toBe(1900); // the options price on top
    await engine.stop();
  }, 15_000);

  it('keeps an option the menu never modeled, rather than losing it', async () => {
    // The live failure this exists for (2026-08-31): the caller asked for BBQ
    // wings, the menu had no sauce group at all, and the choice vanished from
    // the order while the bot said "BBQ boneless wings added" out loud.
    const stt = new FakeStt();
    const tts = new FakeTts();
    let placed: { lines: OrderLine[] } | undefined;
    const engine = new ConversationEngine({
      providers: { stt, llm: new OrderLlm(), tts },
      context: { callId: 'call-mods-2', sampleRate: 8000, restaurantName: "Mario's" },
      io: { sendAudio: () => {}, send: () => {} },
      log: pino({ level: 'silent' }),
      // Same item, but the restaurant never entered its options.
      loadMenu: async () => [{ id: 'mi-wings', name: 'Boneless Wings', priceCents: 1250 }],
      placeOrder: async (_ctx, lines) => {
        placed = { lines };
        return { orderCode: 'ABCDE', totalCents: 2500 };
      },
    });

    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'two garlic parm boneless wings please', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));
    stt.onSegment!({ text: 'place it under Dana', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: "yes that's right", isFinal: true });
    await waitFor(() => placed !== undefined);

    const line = placed!.lines[0]!;
    expect(line.modifiers).toBeUndefined(); // nothing to price against
    // Every word the caller chose is still on the ticket.
    expect(line.specialInstructions).toContain('Garlic Parm');
    expect(line.specialInstructions).toContain('Boneless');
    expect(line.specialInstructions).toContain('ranch dip');
    await engine.stop();
  }, 15_000);
});
