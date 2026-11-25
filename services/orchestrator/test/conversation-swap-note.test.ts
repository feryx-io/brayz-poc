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
 * A changed option, and the note the model writes about changing it.
 *
 * On the call of 2026-09-04 18:01 the caller switched their wing sauce; the
 * model passed BBQ as the option (right) and also wrote "Sauce changed from
 * Garlic Parmesan to BBQ" as a special instruction (redundant), so the ticket
 * said it twice and the kitchen had a sentence to parse. The engine drops a
 * note that only narrates the swap, and keeps one that asks for anything else.
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
  async synthesize(opts: { onAudio: (f: AudioFrame) => void }): Promise<void> {
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
  async stream(opts: { messages: LlmMessage[]; onEvent: (e: LlmStreamEvent) => void }): Promise<void> {
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
    id: 'mi-wings',
    name: 'Boneless Wings',
    priceCents: 1200,
    modifierGroups: [
      {
        id: 'g-sauce',
        name: 'Sauce',
        selectionType: 'single',
        required: true,
        modifiers: [
          { id: 'm-gp', name: 'Garlic Parmesan', priceCents: 0 },
          { id: 'm-bbq', name: 'BBQ', priceCents: 0 },
          { id: 'm-hot', name: 'Buffalo (Hot)', priceCents: 0 },
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
  const engine = new ConversationEngine({
    providers: { stt, llm, tts: new FakeTts() },
    context: { callId: 'call-swap', sampleRate: 8000, restaurantName: "Jimmy's" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
  });
  const line = () => (engine as unknown as { order: OrderLine[] }).order[0]!;
  const lastTool = () =>
    (engine as unknown as { messages: LlmMessage[] }).messages.filter((m) => m.role === 'tool').at(-1)!.content;
  return { engine, stt, llm, line, lastTool };
}

async function turn(h: ReturnType<typeof buildEngine>, text: string, passes = 1) {
  const before = h.llm.requests;
  h.stt.onSegment!({ text, isFinal: true });
  await waitFor(() => h.llm.requests === before + passes);
  await new Promise((r) => setTimeout(r, 30));
}

describe('Conversation engine — a note that only narrates an option swap', () => {
  it('drops the narration and keeps the swap', async () => {
    const h = buildEngine();
    h.llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Garlic Parmesan'] } }] },
      {
        tools: [
          {
            name: 'update_item',
            arguments: {
              item: 'Boneless Wings',
              modifiers: ['BBQ'],
              special_instructions: 'Sauce changed from Garlic Parmesan to BBQ',
            },
          },
        ],
      },
      { text: 'Changed to BBQ.' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'boneless wings, garlic parm');
    await turn(h, 'actually make that barbecue', 2);

    expect(h.line().modifiers?.map((m) => m.name)).toEqual(['BBQ']);
    expect(h.line().specialInstructions).toBeUndefined();
    expect(h.lastTool()).not.toMatch(/Noted/);
    expect(h.lastTool()).toMatch(/Removed Garlic Parmesan/);
    await h.engine.stop();
  });

  it('keeps a note that asks for something beyond the swap', async () => {
    const h = buildEngine();
    h.llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Garlic Parmesan'] } }] },
      {
        tools: [
          {
            name: 'update_item',
            arguments: { item: 'Boneless Wings', modifiers: ['BBQ'], special_instructions: 'extra sauce on the side' },
          },
        ],
      },
      { text: 'Changed to BBQ, extra on the side.' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'boneless wings, garlic parm');
    await turn(h, 'barbecue instead, and extra sauce on the side', 2);

    expect(h.line().modifiers?.map((m) => m.name)).toEqual(['BBQ']);
    expect(h.line().specialInstructions).toBe('extra sauce on the side');
    expect(h.lastTool()).toMatch(/Noted "extra sauce on the side"/);
    await h.engine.stop();
  });

  it('keeps a note that names only one side of the change', async () => {
    // "No garlic parm" alone is not a narration of a swap to BBQ — it could
    // be a real instruction about what not to do — so it stays.
    const h = buildEngine();
    h.llm.script = [
      { tools: [{ name: 'add_item', arguments: { item: 'Boneless Wings', modifiers: ['Garlic Parmesan'] } }] },
      {
        tools: [
          {
            name: 'update_item',
            arguments: { item: 'Boneless Wings', modifiers: ['BBQ'], special_instructions: 'no garlic parmesan at all' },
          },
        ],
      },
      { text: 'Done.' },
    ];
    await h.engine.start();
    await waitFor(() => h.stt.onSegment !== undefined);
    await turn(h, 'boneless wings, garlic parm');
    await turn(h, 'barbecue, no garlic parm at all', 2);
    expect(h.line().specialInstructions).toBe('no garlic parmesan at all');
    await h.engine.stop();
  });
});
