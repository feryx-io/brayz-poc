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
import { ConversationEngine, type MenuItemInfo } from '../src/conversation.js';

/**
 * The text offer through the real model. The engine asks; what only the model
 * can show is that it reports the caller's answer faithfully — a yes as a yes,
 * a no or a hedge as a no — and never asks the question in its own words.
 * LIVE_MENU_JSON for a real location's menu. Skips without ANTHROPIC_API_KEY.
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

const MENU: MenuItemInfo[] = [{ id: 'mi-large', name: 'Large Pizza (18")', category: 'Create Your Own Pizza', priceCents: 1900 }];

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function orderThenAnswer(answer: string) {
  const stt = new FakeStt();
  const states: string[] = [];
  const turns: string[][] = [[]];
  const consents: Array<{ orderCode: string; callerWords?: string }> = [];
  let placed = false;
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL, thinking: 'disabled' }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-order-texts', sampleRate: 8000, restaurantName: "Jimmy's Pizza - Saratoga" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => (process.env.LIVE_MENU_JSON ? JSON.parse(readFileSync(process.env.LIVE_MENU_JSON, 'utf8')) : MENU),
    loadProfile: async () => ({
      name: "Jimmy's Pizza - Saratoga",
      pickupEnabled: true,
      guestOrderTexts: { offer: true },
    }),
    loadGuest: async () => ({ isReturning: true, displayName: 'James', mode: 'full' as const }),
    placeOrder: async () => {
      placed = true;
      return { orderCode: 'AB12C', totalCents: 1900, etaMinutes: 20 };
    },
    recordOrderTextConsent: async (_ctx, c) => {
      consents.push(c);
      return true;
    },
    onStateChange: (s) => states.push(s),
    onTranscript: (seg, who) => {
      if (who === 'agent') turns.at(-1)!.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000);
  let asked = false;
  let line: string | null = 'A large cheese pizza for pickup, that is everything.';
  for (let i = 0; i < 9 && line; i += 1) {
    turns.push([]);
    const mark = states.length;
    stt.onSegment!({ text: line, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'), 30_000);
    await waitFor(() => states.slice(mark).at(-1) === 'listening', 90_000);
    const said = turns.at(-1)!.join(' ');
    if (asked) {
      line = null;
    } else if (placed && /Would you like a text when your order is ready/.test(said)) {
      asked = true;
      line = answer;
    } else if (/go ahead|should i place|place (the|your) order/i.test(said)) {
      line = 'Yes.';
    } else if (placed) {
      line = null;
    } else if (/topping/i.test(said)) {
      line = 'Just cheese.';
    } else {
      line = "That's it.";
    }
  }
  await engine.stop();
  const all = turns.map((t, i) => `${i}: ${t.join(' ')}`).join('\n');
  // The model never asks the question itself: exactly one offer, the engine's.
  const offers = (all.match(/text when (your|the) order is ready\?/gi) ?? []).length;
  if (process.env.LIVE_PROBE) console.log('PROBE', JSON.stringify({ answer, consents, offers, all }));
  return { consents, offers, all, asked };
}

describe.skipIf(!HAS_KEY)(`Conversation engine — text offer, live model (${MODEL})`, () => {
  for (const [answer, agreed] of [
    ['Yeah, sure.', true],
    ['Yes please, text me.', true],
    ['No thanks.', false],
    ["Nah, I'm good.", false],
  ] as const) {
    it(`reports "${answer}" as ${agreed ? 'a yes' : 'a no'}`, { timeout: 300_000 }, async () => {
      const run = await orderThenAnswer(answer);
      expect(run.asked, run.all).toBe(true);
      expect(run.offers, run.all).toBe(1);
      expect(run.consents.length, run.all).toBe(agreed ? 1 : 0);
      // No goodbye before the question: the call is not over.
      const beforeOffer = run.all.slice(0, run.all.indexOf('Would you like a text'));
      const lastTurn = beforeOffer.split('\n').at(-1) ?? '';
      expect(lastTurn, run.all).not.toMatch(/thanks for calling|see you soon|have a (great|good)/i);
    });
  }
});
