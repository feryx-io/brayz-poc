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
import { ConversationEngine, type MenuItemInfo, type OrderLine } from '../src/conversation.js';

/**
 * Half-and-half pizzas.
 *
 * On the call of 2026-09-04 16:48 the caller asked for "half pepperoni, half
 * sausage" and was told, by the model on its own authority, that toppings go
 * on the whole pizza. The order reached the kitchen as a whole pepperoni-and-
 * sausage pie. The tools now carry a portion per option where the menu allows
 * it, price each half by the menu's rule, and say the halves back the way a
 * person would.
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

const MENU: MenuItemInfo[] = [
  {
    id: 'mi-pizza',
    name: 'Large Pizza (18")',
    category: 'Pizza',
    priceCents: 1900,
    modifierGroups: [
      {
        id: 'g-top',
        name: 'Toppings',
        selectionType: 'multi',
        allowsHalves: true,
        halfPricing: 'full',
        modifiers: [
          { id: 'm-pep', name: 'Pepperoni', priceCents: 150 },
          { id: 'm-saus', name: 'Sausage', priceCents: 150 },
          { id: 'm-mush', name: 'Mushroom', priceCents: 150 },
        ],
      },
    ],
  },
  {
    id: 'mi-half',
    name: 'Medium Pizza (14")',
    category: 'Pizza',
    priceCents: 1500,
    modifierGroups: [
      {
        id: 'g-top-m',
        name: 'Toppings',
        selectionType: 'multi',
        allowsHalves: true,
        // The other pricing rule: a half costs half.
        halfPricing: 'half',
        modifiers: [
          { id: 'm-pep-m', name: 'Pepperoni', priceCents: 150 },
          { id: 'm-saus-m', name: 'Sausage', priceCents: 125 },
        ],
      },
    ],
  },
  {
    id: 'mi-calz',
    name: 'Calzone',
    category: 'Calzones',
    priceCents: 1150,
    modifierGroups: [
      {
        id: 'g-calz',
        name: 'Toppings',
        selectionType: 'multi',
        // One thing: the kitchen cannot split it.
        allowsHalves: false,
        modifiers: [
          { id: 'm-pep-c', name: 'Pepperoni', priceCents: 100 },
          { id: 'm-saus-c', name: 'Sausage', priceCents: 100 },
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

function buildEngine() {
  const stt = new FakeStt();
  const llm = new ScriptedLlm();
  const tts = new FakeTts();
  const placed: Array<{ lines: OrderLine[] }> = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-halves', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    placeOrder: async (_ctx, lines) => {
      placed.push({ lines });
      return { orderCode: 'ABCDE', totalCents: 0 };
    },
  });
  const draft = () => (engine as unknown as { order: OrderLine[] }).order;
  // Read from the engine's own history: the fake model only sees tool results
  // on its next request, and a turn that ends on the fast acknowledgement
  // never makes one.
  const toolResults = () =>
    (engine as unknown as { messages: LlmMessage[] }).messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.content);
  return { engine, stt, llm, tts, placed, draft, toolResults };
}

/** Drive one caller utterance through as many model passes as the script gives it. */
async function turn(h: ReturnType<typeof buildEngine>, text: string, passes: number) {
  const before = h.llm.requests;
  h.stt.onSegment!({ text, isFinal: true });
  await waitFor(() => h.llm.requests === before + passes);
  await new Promise((r) => setTimeout(r, 30));
}

describe('Conversation engine — half-and-half', () => {
  it('puts each half on the line, priced in full, and says it back as halves', async () => {
    const h = buildEngine();
    h.llm.script = [
      {
        tools: [
          {
            name: 'add_item',
            arguments: { item: 'Large Pizza (18")', left_half: ['Pepperoni'], right_half: ['Sausage'] },
          },
        ],
      },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'a large pizza, half pepperoni half sausage', 1);

    const line = h.draft()[0]!;
    expect(line.modifiers).toEqual([
      { id: 'm-pep', name: 'Pepperoni', priceCents: 150, portion: 'left' },
      { id: 'm-saus', name: 'Sausage', priceCents: 150, portion: 'right' },
    ]);
    // Full price per half: the pie plus two toppings.
    expect(h.toolResults().at(-1)).toContain('at $22.00 each');
    expect(h.toolResults().at(-1)).toContain('Large Pizza (18"), half Pepperoni, half Sausage');
    // The fast acknowledgement, which is what the caller actually hears.
    expect(h.tts.spoken.at(-1)).toBe('Got it — Large Pizza, half Pepperoni, half Sausage. Anything else?');
    await h.engine.stop();
  });

  it('prices a half at half where the menu says so, rounding up', async () => {
    const h = buildEngine();
    h.llm.script = [
      {
        tools: [
          {
            name: 'add_item',
            arguments: { item: 'Medium Pizza (14")', left_half: ['Pepperoni'], right_half: ['Sausage'] },
          },
        ],
      },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'medium, half pepperoni half sausage', 1);

    const line = h.draft()[0]!;
    // 150/2 = 75; 125/2 = 62.5 rounds up to 63 so two halves never undercut a whole.
    expect(line.modifiers?.map((m) => m.priceCents)).toEqual([75, 63]);
    expect(h.toolResults().at(-1)).toContain('at $16.38 each');
    await h.engine.stop();
  });

  it('mixes whole toppings with halves, whole first', async () => {
    const h = buildEngine();
    h.llm.script = [
      {
        tools: [
          {
            name: 'add_item',
            arguments: {
              item: 'Large Pizza (18")',
              modifiers: ['Mushroom'],
              left_half: ['Pepperoni'],
              right_half: ['Sausage'],
            },
          },
        ],
      },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'mushroom all over, half pepperoni half sausage', 1);
    expect(h.tts.spoken.at(-1)).toBe(
      'Got it — Large Pizza with Mushroom, half Pepperoni, half Sausage. Anything else?',
    );
    expect(h.draft()[0]!.modifiers?.map((m) => [m.name, m.portion ?? 'whole'])).toEqual([
      ['Mushroom', 'whole'],
      ['Pepperoni', 'left'],
      ['Sausage', 'right'],
    ]);
    await h.engine.stop();
  });

  it('refuses halves on an item the menu says is one thing, adding nothing', async () => {
    const h = buildEngine();
    h.llm.script = [
      {
        tools: [
          {
            name: 'add_item',
            arguments: { item: 'Calzone', left_half: ['Pepperoni'], right_half: ['Sausage'] },
          },
        ],
      },
      { text: 'A calzone comes as one piece — would you like pepperoni and sausage on the whole thing?' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'a calzone, half pepperoni half sausage', 2);

    // Not a whole calzone with both, and not a plain one either: nothing.
    expect(h.draft()).toHaveLength(0);
    const refusal = h.toolResults().at(-1)!;
    expect(refusal).toMatch(/cannot be made half-and-half/);
    expect(refusal).toMatch(/Pepperoni and Sausage on the whole Calzone/);
    await h.engine.stop();
  });

  it('adds a half topping to a pizza already on the order, and reads the halves back', async () => {
    const h = buildEngine();
    h.llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pizza (18")', left_half: ['Pepperoni'] } }] },
      { tools: [{ name: 'update_item', arguments: { item: 'Large Pizza', right_half: ['Sausage'] } }] },
      { tools: [{ name: 'review_order', arguments: { customer_name: 'Jim' } }] },
      { text: 'Should I go ahead and place the order under Jim?' },
      { tools: [{ name: 'place_order' }] },
      { text: 'Done.' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'large pizza, pepperoni on half', 1);
    await turn(h, 'and sausage on the other half', 1);
    expect(h.toolResults().at(-1)).toContain('Added Sausage (right half).');
    expect(h.tts.spoken.at(-1)).toBe('Done — Large Pizza, half Pepperoni, half Sausage. Anything else?');

    await turn(h, "that's it", 2);
    expect(h.toolResults().find((r) => /Current order:/.test(r))).toContain(
      '1 Large Pizza (18"), half Pepperoni, half Sausage — $22.00',
    );

    await turn(h, 'yes', 2);
    await waitFor(() => h.placed.length === 1);
    // What goes to the API: ids and portions, for it to price again (rule #5).
    expect(h.placed[0]!.lines[0]!.modifiers).toMatchObject([
      { id: 'm-pep', portion: 'left' },
      { id: 'm-saus', portion: 'right' },
    ]);
    await h.engine.stop();
  }, 15_000);

  it('asking for the same half again changes nothing', async () => {
    const h = buildEngine();
    h.llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Large Pizza (18")', left_half: ['Pepperoni'] } }] },
      { tools: [{ name: 'update_item', arguments: { item: 'Large Pizza', left_half: ['Pepperoni'] } }] },
      { text: 'Pepperoni is already on the left half.' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'large pizza, pepperoni on half', 1);
    await turn(h, 'pepperoni on the left', 2);
    expect(h.toolResults().at(-1)).toMatch(/already has Pepperoni \(left half\)/);
    expect(h.draft()[0]!.modifiers).toHaveLength(1);
    await h.engine.stop();
  });

  it('tells the model which groups allow halves, in the menu it reads', async () => {
    const h = buildEngine();
    h.llm.script = [{ text: 'Sure.' }];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'hello', 1);
    const menu = h.llm.systemMessages.join('\n');
    expect(menu).toContain('Toppings (half-and-half allowed): Pepperoni +$1.50');
    // The calzone's group carries no such mark.
    expect(menu).toMatch(/Calzone[^\n]*\n\s+Toppings: Pepperoni/);
    await h.engine.stop();
  });
});
