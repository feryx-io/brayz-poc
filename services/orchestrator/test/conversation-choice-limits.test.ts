import { describe, expect, it } from 'vitest';
import pino from 'pino';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  LlmToolCall,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import {
  ConversationEngine,
  tooManyChoices,
  type MenuItemInfo,
  type MenuModifierInfo,
  type OrderLine,
} from '../src/conversation.js';

/**
 * More choices from one option group than the menu allows.
 *
 * The call of 2026-09-14 16:46: "Wings. Half barbecue, half garlic parm." The
 * bot said "I can do that", passed both sauces to add_item, and the
 * single-choice rule let Garlic Parmesan replace BBQ without a word — the tool
 * reported the wings as added "with Blue Cheese, Garlic Parmesan", and that is
 * what was read back to a caller who had asked for BBQ.
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

/** Makes each scripted tool call in turn, then relays the tool's words. */
class ScriptLlm implements LlmProvider {
  readonly name = 'fake-llm';
  system = '';
  constructor(private readonly calls: LlmToolCall[]) {}
  async stream(opts: { messages: { role: string; content: string }[]; onEvent: (e: LlmStreamEvent) => void }) {
    this.system = opts.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const last = opts.messages[opts.messages.length - 1]!;
    if (last.role === 'tool') {
      opts.onEvent({ type: 'text', textDelta: last.content });
    } else {
      const next = this.calls.shift();
      if (next) opts.onEvent({ type: 'tool_call', toolCall: next });
      else opts.onEvent({ type: 'text', textDelta: 'OK.' });
    }
    opts.onEvent({ type: 'done' });
  }
}

const opt = (name: string): MenuModifierInfo => ({ id: `m-${name.toLowerCase().replace(/\W+/g, '-')}`, name, priceCents: 0 });
const SAUCES = ['BBQ', 'Garlic Parmesan', 'Buffalo (Mild)'].map(opt);
const TOPPINGS = ['Chicken', 'Bacon', 'Onion'].map(opt);
const WINGS: MenuItemInfo = {
  id: 'mi-wings',
  name: 'Wings',
  priceCents: 1650,
  modifierGroups: [
    { id: 'g-sauce', name: 'Sauce', selectionType: 'single', required: true, minSelections: 1, maxSelections: 1, modifiers: SAUCES },
    { id: 'g-dip', name: 'Dip', selectionType: 'single', required: true, modifiers: ['Blue Cheese', 'Ranch'].map(opt) },
  ],
};
const QUESADILLA: MenuItemInfo = {
  id: 'mi-q',
  name: 'Quesadilla',
  priceCents: 825,
  modifierGroups: [{ id: 'g-top', name: 'Toppings', selectionType: 'multi', maxSelections: 2, modifiers: TOPPINGS }],
};

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function run(calls: LlmToolCall[], lines: string[]) {
  const stt = new FakeStt();
  const tts = new FakeTts();
  const llm = new ScriptLlm(calls);
  const states: string[] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-limits', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => [WINGS, QUESADILLA],
    loadProfile: async () => ({ name: "Jimmy's", orderAckMode: 'natural' as const }),
    onStateChange: (s) => states.push(s),
  });
  await engine.start();
  await waitFor(() => states.includes('listening'));
  for (const text of lines) {
    const mark = states.length;
    stt.onSegment!({ text, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'));
    await waitFor(() => states.slice(mark).at(-1) === 'listening');
  }
  const order = (engine as unknown as { order: OrderLine[] }).order;
  await engine.stop();
  return { spoken: tts.spoken.join(' '), order, system: llm.system };
}

describe('Conversation engine — more choices than a group allows', () => {
  it('does not add wings with two sauces, and says to ask which one', async () => {
    const { spoken, order } = await run(
      [{ id: 'a1', name: 'add_item', arguments: { item: 'Wings', modifiers: ['Blue Cheese', 'BBQ', 'Garlic Parmesan'] } }],
      ['Wings. Half barbecue, half garlic parm.'],
    );
    expect(order).toEqual([]);
    expect(spoken).toContain('Wings takes one sauce');
    expect(spoken).toContain('BBQ and Garlic Parmesan');
    expect(spoken).toContain('cannot be split half and half');
  });

  it('still lets a later request swap the one sauce ("make that mild")', async () => {
    const { order } = await run(
      [
        { id: 'a1', name: 'add_item', arguments: { item: 'Wings', modifiers: ['BBQ', 'Ranch'] } },
        { id: 'u1', name: 'update_item', arguments: { item: 'Wings', modifiers: ['Buffalo (Mild)'] } },
      ],
      ['Wings, BBQ with ranch.', 'Actually make that mild.'],
    );
    expect(order[0]!.modifiers!.map((m) => m.name).sort()).toEqual(['Buffalo (Mild)', 'Ranch']);
  });

  it('does not let a note carry the second sauce the choice was refused', async () => {
    // The retest of 2026-09-14 17:23: refused nothing (it never asked for two
    // sauces as options), the model put "Half BBQ sauce, half Garlic Parmesan
    // sauce" in special_instructions and the ticket said so.
    const { spoken, order } = await run(
      [
        {
          id: 'a1',
          name: 'add_item',
          arguments: { item: 'Wings', modifiers: ['Blue Cheese'], special_instructions: 'Half BBQ sauce, half Garlic Parmesan sauce' },
        },
      ],
      ['Wings. Half barbecue, half garlic parm.'],
    );
    expect(order).toEqual([]);
    expect(spoken).toContain('A special-instructions note cannot add another one either');
    expect(spoken).toContain('each is its own order of Wings');
  });

  it('still takes a note that only narrates a sauce swap, or names nothing on the menu', async () => {
    const { order } = await run(
      [
        { id: 'a1', name: 'add_item', arguments: { item: 'Wings', modifiers: ['Garlic Parmesan', 'Ranch'], special_instructions: 'extra crispy' } },
        { id: 'u1', name: 'update_item', arguments: { item: 'Wings', modifiers: ['BBQ'], special_instructions: 'BBQ instead of Garlic Parmesan' } },
      ],
      ['Wings, garlic parm, ranch, extra crispy.', 'Actually BBQ instead.'],
    );
    expect(order).toHaveLength(1);
    expect(order[0]!.modifiers!.map((m) => m.name).sort()).toEqual(['BBQ', 'Ranch']);
    expect(order[0]!.specialInstructions).toContain('extra crispy');
  });

  it('tells the model the limit in the menu, before it answers', async () => {
    const { system } = await run([], ['Hi.']);
    expect(system).toMatch(/Sauce \(required, choose one\)/);
    expect(system).toMatch(/Toppings \(up to 2\)/);
  });
});

describe('tooManyChoices', () => {
  it('counts a capped group, including what the line already has', () => {
    expect(tooManyChoices(QUESADILLA, [TOPPINGS[0]!, TOPPINGS[1]!], [])).toBeNull();
    expect(tooManyChoices(QUESADILLA, TOPPINGS, [])).toContain('takes up to 2 toppings');
    expect(tooManyChoices(QUESADILLA, [TOPPINGS[2]!], [TOPPINGS[0]!, TOPPINGS[1]!])).toContain(
      'it already has Chicken, Bacon',
    );
  });

  it('counts a group that allows halves per side', () => {
    const pizza: MenuItemInfo = {
      name: 'Pizza',
      priceCents: 1500,
      modifierGroups: [{ id: 'g', name: 'Toppings', selectionType: 'multi', maxSelections: 1, allowsHalves: true, modifiers: TOPPINGS }],
    };
    const left = { ...TOPPINGS[0]!, portion: 'left' as const };
    const right = { ...TOPPINGS[1]!, portion: 'right' as const };
    expect(tooManyChoices(pizza, [left, right], [])).toBeNull();
    expect(tooManyChoices(pizza, [left, { ...TOPPINGS[2]!, portion: 'left' as const }], [])).not.toBeNull();
  });

  it('counts options a note names against the limit', () => {
    expect(tooManyChoices(WINGS, [], [], 'half BBQ, half Garlic Parmesan')).toContain('takes one sauce');
    expect(tooManyChoices(WINGS, [SAUCES[0]!], [], 'extra BBQ please')).toBeNull();
    expect(tooManyChoices(QUESADILLA, [TOPPINGS[0]!, TOPPINGS[1]!], [], 'add onion too')).toContain('up to 2');
  });

  it('leaves a group with no limit alone', () => {
    const open: MenuItemInfo = { name: 'Salad', priceCents: 900, modifierGroups: [{ id: 'g', name: 'Extras', selectionType: 'multi', modifiers: TOPPINGS }] };
    expect(tooManyChoices(open, TOPPINGS, [])).toBeNull();
  });
});
