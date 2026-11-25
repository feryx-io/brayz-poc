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
 * Asking for a person at a location with nobody to transfer to, through the
 * real model.
 *
 * The call of 2026-09-14 19:23 (Saratoga: no transfer options, persona switching
 * off): "Is Sarah there?" → "I'd be happy to transfer you or take a message for
 * Sarah." There was no transfer to make. conversation-transfer.test.ts proves the
 * tool and the prompt line are gone; this shows the model stops offering one.
 * Measured before merging, Saratoga's real menu, 6 runs of each question: the
 * old prompt offered a transfer 2/12 (both "Is Sarah there?"), the new 0/12.
 * Pass LIVE_MENU_JSON (a real location's menu) for a faithful run. Skips without
 * ANTHROPIC_API_KEY.
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

const MENU: MenuItemInfo[] = [
  { id: 'mi-large', name: 'Large Pizza (18")', category: 'Create Your Own Pizza', priceCents: 1900 },
  { id: 'mi-knots', name: 'Knots', category: 'Starters', priceCents: 625 },
];

/**
 * An offer to transfer, as opposed to saying there is no one to transfer to
 * ("Mike isn't someone I can transfer you to" is honest and fine).
 */
function offersTransfer(reply: string): boolean {
  for (const sentence of reply.split(/(?<=[.?!])\s+/)) {
    if (!/\b(transfer|connect you|put you through)/i.test(sentence)) continue;
    if (/\b(isn'?t|not|no|nobody|unable|can'?t|don'?t have)\b/i.test(sentence)) continue;
    return true;
  }
  return false;
}

async function waitFor(pred: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function ask(line: string, personas: string[]): Promise<string> {
  const stt = new FakeStt();
  const states: string[] = [];
  const spoken: string[][] = [[]];
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL, thinking: 'disabled' }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-transfer', sampleRate: 8000, restaurantName: "Jimmy's Pizza - Saratoga" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => (process.env.LIVE_MENU_JSON ? JSON.parse(readFileSync(process.env.LIVE_MENU_JSON, 'utf8')) : MENU),
    loadProfile: async () => ({ name: "Jimmy's Pizza - Saratoga", pickupEnabled: true, deliveryEnabled: true }),
    loadGuest: async () => ({ isReturning: true, displayName: 'James', mode: 'full' as const }),
    loadVoice: async () => ({ staffName: 'Jose', voiceId: 'aura-2-hermes-en' }),
    loadPersonas: async () => personas,
    loadTransferTargets: async () => [],
    onStateChange: (s) => states.push(s),
    onTranscript: (seg, who) => {
      if (who === 'agent') spoken.at(-1)!.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000);
  spoken.push([]);
  const mark = states.length;
  stt.onSegment!({ text: line, isFinal: true });
  await waitFor(() => states.slice(mark).includes('thinking'), 30_000);
  await waitFor(() => states.slice(mark).at(-1) === 'listening', 90_000);
  await engine.stop();
  const reply = spoken[1]!.join(' ');
  if (process.env.LIVE_PROBE) console.log('PROBE', JSON.stringify({ line, personas: personas.length, reply }));
  return reply;
}

describe.skipIf(!HAS_KEY)(`Conversation engine — no one to transfer to, live model (${MODEL})`, () => {
  it('asked for a staff member with persona switching off, offers a message and never a transfer', { timeout: 120_000 }, async () => {
    const reply = await ask('Is Sarah there?', []);
    expect(offersTransfer(reply), reply).toBe(false);
  });

  it('asked for someone who is not a persona, offers a message and never a transfer', { timeout: 120_000 }, async () => {
    const reply = await ask('Can I talk to Mike?', ['Jose', 'Sarah']);
    expect(offersTransfer(reply), reply).toBe(false);
  });
});
