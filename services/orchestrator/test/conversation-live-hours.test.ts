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
 * Closed hours and ordering ahead, through the real model.
 *
 * conversation-hours.test.ts proves what the engine hands the model. What only
 * the model can show is what the closed calls of 2026-09-14 got wrong around
 * those tools:
 * - "Wednesday at six" became schedule_order(day: "2026-09-02") — a date the
 *   model made up, twelve days gone — instead of the day as the caller said it;
 * - the bot offered "right at 11 AM" itself, a time the kitchen could not do.
 *
 * Measured before merging, 6 runs each: the old prompt passed "2026-09-02" for
 * Wednesday 5 times and never the weekday; the new one passed the weekday 6/6.
 * The time case did not reproduce on the old prompt either (0/6), so its
 * prompt line is a guard, not a proven fix. Message wording was tried and
 * dropped: both rewordings made "I'll pass that along" before take_message
 * more common (5/6, 2/6) than the original prompt (1/6).
 * Skips without ANTHROPIC_API_KEY. Run each case more than once; one sample is
 * noise (see conversation-live.test.ts).
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
  { id: 'mi-knots', name: 'Garlic Knots', category: 'Starters', priceCents: 599 },
];

/** Saratoga at 10:18 on a Monday: shut until eleven, taking orders a day ahead. */
const CLOSED_PROFILE = {
  name: "Jimmy's Pizza - Saratoga",
  pickupEnabled: true,
  pickupEtaMinutes: 20,
  openNow: false,
  hoursKnown: true,
  announceClosed: true,
  offerMessageWhenClosed: true,
  hoursToday: '11:00 AM to 10:00 PM',
  nextOpen: { at: '2026-09-14T15:00:00.000Z', spoken: 'today at 11:00 AM' },
  scheduling: { enabled: true, maxDaysAhead: 1, leadMinutes: 20, today: 'Monday, September 14' },
  aiGreetings: ["Thank you for calling Jimmy's Pizza, Saratoga. What can I get started for you today?"],
  greeting: "Thank you for calling Jimmy's Pizza, Saratoga. What can I get started for you today?",
};

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Run {
  /** Agent lines per caller turn (index 0 = the greeting). */
  turns: string[][];
  scheduled: Array<{ time: string; day?: string }>;
}

async function call(
  lines: string[] | ((said: string, turn: number, run: Run) => string | null),
  maxTurns = 6,
): Promise<Run> {
  const stt = new FakeStt();
  const states: string[] = [];
  const run: Run = { turns: [[]], scheduled: [] };
  const engine = new ConversationEngine({
    providers: {
      stt,
      llm: new AnthropicLlmProvider({ apiKey: process.env.ANTHROPIC_API_KEY!, model: MODEL, thinking: 'disabled' }),
      tts: new FakeTts(),
    },
    context: { callId: 'live-hours', sampleRate: 8000, restaurantName: "Jimmy's Pizza - Saratoga" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadMenu: async () => MENU,
    loadProfile: async () => CLOSED_PROFILE,
    loadGuest: async () => ({ isReturning: true, displayName: 'James', mode: 'full' as const }),
    // Real model, fake API: Wednesday is too far, tomorrow works, eleven is too soon.
    scheduleOrder: async (_ctx, req) => {
      run.scheduled.push(req);
      const day = (req.day ?? 'today').toLowerCase();
      if (day === 'tomorrow') {
        return { ok: true as const, scheduledFor: '2026-09-15T22:00:00.000Z', spoken: 'tomorrow at 6:00 PM' };
      }
      if (day === 'today' && req.time >= '11:20') {
        return { ok: true as const, scheduledFor: '2026-09-14T15:30:00.000Z', spoken: `today at ${req.time}` };
      }
      if (day === 'today') {
        return {
          ok: false as const,
          reason: 'too_soon',
          earliest: { at: '2026-09-14T15:20:00.000Z', spoken: 'today at 11:20 AM' },
        };
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < '2026-09-14') {
        return { ok: false as const, reason: 'past', earliest: { at: '2026-09-14T15:20:00.000Z', spoken: 'today at 11:20 AM' } };
      }
      return {
        ok: false as const,
        reason: 'too_far',
        earliest: { at: '2026-09-14T15:20:00.000Z', spoken: 'today at 11:20 AM' },
        latest: { at: '2026-09-15T22:00:00.000Z', spoken: 'tomorrow at 6:00 PM' },
      };
    },
    onStateChange: (s) => states.push(s),
    onTranscript: (seg, who) => {
      if (who === 'agent') run.turns.at(-1)!.push(seg.text);
    },
  });
  await engine.start();
  await waitFor(() => states.includes('listening'), 30_000, 'the greeting to finish');

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const said = run.turns.at(-1)!.join(' ');
    const line = Array.isArray(lines) ? lines[turn] : lines(said, turn, run);
    if (!line) break;
    run.turns.push([]);
    const mark = states.length;
    stt.onSegment!({ text: line, isFinal: true });
    await waitFor(() => states.slice(mark).includes('thinking'), 30_000, 'the turn to start');
    await waitFor(() => states.slice(mark).at(-1) === 'listening', 90_000, 'the turn to finish');
  }
  await engine.stop();
  return run;
}

describe.skipIf(!HAS_KEY)(`Conversation engine — closed hours, live model (${MODEL})`, () => {
  it('passes "Wednesday" as the day it was said, and offers tomorrow when that is too far', { timeout: 300_000 }, async () => {
    const run = await call(['Large pizza for pickup.', "That's it.", 'Can I get it Wednesday at 6pm?']);
    const all = run.turns.flat().join(' | ');
    expect(run.scheduled.length, all).toBeGreaterThan(0);
    const wednesday = run.scheduled.find((r) => /wednesday|2026-09-16/i.test(r.day ?? ''));
    expect(wednesday, JSON.stringify(run.scheduled) + ' :: ' + all).toBeDefined();
    // Never a date the model worked out for itself from the weekday.
    expect(run.scheduled.some((r) => /^\d{4}-/.test(r.day ?? '') && r.day !== '2026-09-16'), JSON.stringify(run.scheduled)).toBe(false);
    expect(run.turns.at(-1)!.join(' '), all).toMatch(/tomorrow/i);
  });

  it('asks for a time without offering one itself', { timeout: 300_000 }, async () => {
    // The caller answers whatever is asked and stops once asked for a time.
    const run = await call((said, turn) => {
      if (turn === 0) return 'I want a large pizza for when you open.';
      if (/what time|when would you|time would you|does that work|would that work/i.test(said)) return null;
      if (/usual/i.test(said)) return 'Something new.';
      if (/topping|plain|cheese/i.test(said)) return 'Just cheese.';
      return "That's it.";
    });
    const all = run.turns.map((t, i) => `${i}: ${t.join(' ')}`).join('\n');
    const replies = run.turns.slice(1).flat().join(' ');
    // It either asked, or checked the time the caller implied ("when you
    // open") with the tool — and never put eleven to the caller itself.
    expect(/what time|when would you|time would you/i.test(replies) || run.scheduled.length > 0, all).toBe(true);
    expect(replies, all).not.toMatch(/(right at|ready at|for|at) (11|eleven)( ?(:00|o'clock))?( ?(AM|a\.m\.))?[^.?!]*\?/i);
  });
});
