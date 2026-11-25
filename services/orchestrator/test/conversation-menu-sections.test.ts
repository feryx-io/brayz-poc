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
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * The menu the bot is given is grouped by section.
 *
 * On a real call (2026-08-31) the caller asked for "one sausage pizza". The menu
 * has no pizza by that name — it has a Hot Subs item literally named "Sausage"
 * and build-your-own pizzas with a Sausage topping. The prompt listed every item
 * in one flat list, so the sub and the pizzas read alike: the bot took the sub,
 * asked the caller to choose its cheese and sauce, and then had to tell him
 * mid-order that his pizza was a sandwich.
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
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    opts.onAudio(new Uint8Array(320));
  }
}

/** Records the prompt the model is handed, which is what this test is about. */
class RecordingLlm implements LlmProvider {
  readonly name = 'fake-llm';
  messages: { role: string; content: string }[] = [];
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.messages = opts.messages;
    opts.onEvent({ type: 'text', textDelta: 'ok' });
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [
  {
    id: 'mi-large',
    name: 'Large Pizza (18")',
    category: 'Create Your Own Pizza',
    priceCents: 1900,
    modifierGroups: [
      {
        id: 'g-top',
        name: 'Toppings',
        selectionType: 'multi',
        modifiers: [{ id: 'm-saus', name: 'Sausage', priceCents: 150 }],
      },
    ],
  },
  {
    id: 'mi-small',
    name: 'Small Pizza (12")',
    category: 'Create Your Own Pizza',
    priceCents: 1275,
  },
  {
    id: 'mi-sub',
    name: 'Sausage',
    category: 'Hot Subs',
    priceCents: 1200,
    description: 'Choose cheese + sauce + add onion & green pepper',
  },
];

function systemPrompt(llm: RecordingLlm): string {
  return llm.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for the model to be called');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function promptFor(menu: MenuItemInfo[]): Promise<string> {
  const llm = new RecordingLlm();
  const stt = new FakeStt();
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-sections', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => menu,
  });
  await engine.start();
  // start() only builds the messages; a caller turn is what hands them to the model.
  await waitFor(() => stt.onSegment !== undefined);
  stt.onSegment!({ text: 'one sausage pizza', isFinal: true });
  await waitFor(() => llm.messages.length > 0);
  return systemPrompt(llm);
}

describe('Conversation engine — menu sections', () => {
  it('lists each item under its menu section', async () => {
    const prompt = await promptFor(MENU);

    expect(prompt).toContain('Hot Subs:\n- Sausage — $12.00');
    expect(prompt).toContain('Create Your Own Pizza:\n- Large Pizza (18") — $19.00');
    // Section headers appear once, with their items beneath them.
    expect(prompt.match(/^Create Your Own Pizza:$/gm)).toHaveLength(1);
    // And the bot is told to hand a pizza named by its toppings straight to the
    // tool, which is where that resolution now lives.
    expect(prompt).toMatch(/pass what they.*said to add_item unchanged/is);
  });

  it('lists items with no section without inventing a heading for them', async () => {
    const prompt = await promptFor([{ id: 'mi-x', name: 'Garlic Knots', priceCents: 599 }]);

    expect(prompt).toContain('- Garlic Knots — $5.99');
    expect(prompt).not.toMatch(/^(undefined|null|):$/m);
  });
});
