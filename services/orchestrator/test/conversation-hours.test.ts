import { afterEach, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  LlmToolDefinition,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { createMediaServer, type ConversationFactory, type MediaServerHandle } from '../src/mediaServer.js';
import { ConversationEngine, withClosedNotice, type MenuItemInfo, type OrderLine } from '../src/conversation.js';
import type { CallPersistence } from '../src/persistence.js';

class SpyPersistence implements CallPersistence {
  async ensureCall(input: { callId?: string }) {
    return { id: input.callId ?? 'call-1', tenantId: 't', locationId: 'l' };
  }
  async postEvent() {}
  async completeCall() {}
}
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

/**
 * Takes one pizza, then does whatever the caller's words ask for: schedules a
 * time, reads the order back, places it. Relays every tool result as speech,
 * which is what a real model does and what lets the test read the answer.
 */
class HoursLlm implements LlmProvider {
  readonly name = 'fake-llm';
  /** The tool surface the engine offered on the last pass. */
  offered: string[] = [];
  /** The system prompt the engine built. */
  system = '';
  async stream(opts: {
    messages: { role: string; content: string }[];
    tools?: LlmToolDefinition[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.offered = (opts.tools ?? []).map((t) => t.name);
    this.system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
    const msgs = opts.messages;
    const last = msgs[msgs.length - 1]!;
    if (last.role === 'tool') {
      for (const ch of last.content.match(/[\s\S]{1,8}/g) ?? []) opts.onEvent({ type: 'text', textDelta: ch });
      opts.onEvent({ type: 'done' });
      return;
    }
    const said = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
    const call = (name: string, args: Record<string, unknown>) =>
      opts.onEvent({ type: 'tool_call', toolCall: { id: `t-${name}`, name, arguments: args } });
    if (/wednesday/i.test(said)) call('schedule_order', { time: '18:00', day: 'wednesday' });
    else if (/six|18:00/i.test(said)) call('schedule_order', { time: '18:00' });
    else if (/pickup/i.test(said)) call('set_fulfillment', { type: 'pickup' });
    else if (/half past nine|21:30/i.test(said)) call('schedule_order', { time: '21:30' });
    else if (/^yes|go ahead/i.test(said)) call('place_order', { customer_name: 'Sam' });
    else if (/read it back|that'?s it/i.test(said)) call('review_order', { customer_name: 'Sam' });
    else call('add_item', { item: 'Large Pepperoni', quantity: 1 });
    opts.onEvent({ type: 'done' });
  }
}

const MENU: MenuItemInfo[] = [{ id: 'mi-1', name: 'Large Pepperoni', priceCents: 1800 }];

async function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A closed restaurant that takes orders for later, unless told otherwise. */
const CLOSED_PROFILE = {
  name: "Jimmy's",
  // The AI words each confirmation, so the tool's own answer reaches the
  // transcript this test reads.
  orderAckMode: 'natural' as const,
  openNow: false,
  hoursKnown: true,
  announceClosed: true,
  hoursToday: '11:00 AM to 10:00 PM',
  nextOpen: { at: '2026-09-13T15:00:00.000Z', spoken: 'tomorrow at 11:00 AM' },
  scheduling: { enabled: true, maxDaysAhead: 1, leadMinutes: 20 },
};

describe('Conversation engine — closed hours and ordering ahead', () => {
  let media: MediaServerHandle | undefined;
  let socket: WebSocket | undefined;

  afterEach(async () => {
    // Closed here rather than at the end of each test: an assertion that fails
    // mid-call would otherwise leave the socket open and hang the shutdown.
    socket?.close();
    socket = undefined;
    await media?.close();
    media = undefined;
  });

  /** Stands up one call against a profile, and returns the pieces to drive it. */
  async function callWith(
    profile: Record<string, unknown>,
    opts: { scheduleOk?: boolean; refusal?: 'closed_then' | 'too_far' } = {},
  ) {
    const stt = new FakeStt();
    const tts = new FakeTts();
    const llm = new HoursLlm();
    let placed: { lines: OrderLine[]; opts: { scheduledFor?: string } } | undefined;
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({
        providers: { stt, llm, tts },
        context,
        io,
        log,
        loadMenu: async () => MENU,
        loadProfile: async () => profile,
        scheduleOrder: async (_ctx, req) =>
          opts.scheduleOk === false
            ? {
                ok: false as const,
                reason: opts.refusal ?? 'closed_then',
                earliest: { at: '2026-09-13T15:20:00.000Z', spoken: 'tomorrow at 11:20 AM' },
                ...(opts.refusal === 'too_far'
                  ? { latest: { at: '2026-09-13T22:00:00.000Z', spoken: 'tomorrow at 6:00 PM' } }
                  : {}),
              }
            : {
                ok: true as const,
                scheduledFor: '2026-09-13T22:00:00.000Z',
                spoken: `tomorrow at ${req.time === '18:00' ? '6:00 PM' : '9:30 PM'}`,
              },
        placeOrder: async (_ctx, lines, o) => {
          placed = { lines, opts: o };
          return { orderCode: 'ABCDE', totalCents: 1800, scheduledSpoken: o.scheduledFor ? 'tomorrow at 6:00 PM' : null };
        },
      });
    media = createMediaServer({
      log: pino({ level: 'silent' }),
      persistence: new SpyPersistence(),
      nodeId: 'test',
      conversationFactory: factory,
    });
    const port = await media.listen(0);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: `siphon-${Math.random().toString(36).slice(2)}`,
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );
    // The greeting is spoken sentence by sentence, so it is read as a whole.
    await waitFor(() => stt.onSegment !== undefined && tts.spoken.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    socket = ws;
    const since = (n: number) => tts.spoken.slice(n).join(' ');
    return { stt, tts, llm, ws, since, greeting: () => tts.spoken.join(' '), placed: () => placed };
  }

  it('says it is closed in the greeting, with the next opening and what it can do', async () => {
    const { greeting } = await callWith(CLOSED_PROFILE);
    expect(greeting()).toContain("We're closed right now");
    expect(greeting()).toContain('tomorrow at 11:00 AM');
    expect(greeting()).toContain('order for when we open');
  });

  it('offers a message instead when the location does not take orders ahead', async () => {
    const { stt, tts, llm, greeting } = await callWith({
      ...CLOSED_PROFILE,
      scheduling: { enabled: false, maxDaysAhead: 0, leadMinutes: 20 },
    });
    expect(greeting()).toContain('take a message');
    expect(greeting()).not.toContain('order for when we open');
    // A tool it cannot use is never put in front of the model: the model would
    // eventually try it, and "we don't do that" is a worse answer than silence.
    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Added 1 Large Pepperoni/i.test(s)));
    expect(llm.offered).not.toContain('schedule_order');
  });

  it('will not place an order while the restaurant is closed until a time is agreed', async () => {
    const { stt, tts, since, placed } = await callWith(CLOSED_PROFILE);
    const afterGreeting = tts.spoken.length;
    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Added 1 Large Pepperoni/i.test(s)));
    stt.onSegment!({ text: "that's it, read it back", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: 'yes, go ahead', isFinal: true });
    await waitFor(() => /what time/i.test(since(afterGreeting)));
    // Held, not placed — and the bot is told to ask for a time instead.
    expect(placed()).toBeUndefined();
    expect(since(afterGreeting)).toContain('closed right now');
  });

  it('takes the order for the time it agreed, reads it back, and passes it on', async () => {
    const { stt, tts, placed } = await callWith(CLOSED_PROFILE);
    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Added 1 Large Pepperoni/i.test(s)));

    stt.onSegment!({ text: 'can I get it at six', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /That time works/i.test(s)));

    stt.onSegment!({ text: "that's it, read it back", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    // The time is part of what the caller is agreeing to.
    // Spoken sentence by sentence, so the read-back is read as a whole.
    expect(tts.spoken.join(' ')).toContain('For tomorrow at 6:00 PM');

    stt.onSegment!({ text: 'yes, go ahead', isFinal: true });
    await waitFor(() => placed() !== undefined);
    expect(placed()!.opts.scheduledFor).toBe('2026-09-13T22:00:00.000Z');
    // Quoted by its time, never also as a wait in minutes.
    await waitFor(() => tts.spoken.some((s) => /ready for pickup tomorrow at 6:00 PM/i.test(s)));
    expect(tts.spoken.some((s) => /in about \d+ minutes/i.test(s))).toBe(false);
  });

  it('relays a refused time with the earliest one that works', async () => {
    const { stt, tts } = await callWith(CLOSED_PROFILE, { scheduleOk: false });
    stt.onSegment!({ text: 'can I get it at half past nine', isFinal: true });
    await waitFor(() => tts.spoken.join(' ').includes('closed at that time'));
    expect(tts.spoken.join(' ')).toContain('tomorrow at 11:20 AM');
  });

  it('puts the closed notice where the greeting asked what it can get started', async () => {
    // Every closed call of 2026-09-14 heard "What can I get started for you
    // today? We're closed right now." — a question, then the reason it cannot
    // be answered.
    const { greeting } = await callWith(CLOSED_PROFILE);
    expect(greeting()).not.toContain('How can I help you today?');
    expect(greeting()).toMatch(/Thanks for calling Jimmy's\. We're closed right now\./);
  });

  it('once a time is booked, pickup is quoted by that time and not as a wait', async () => {
    const { stt, tts, since } = await callWith(CLOSED_PROFILE);
    stt.onSegment!({ text: 'can I get it at six', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /That time works/i.test(s)));
    const before = tts.spoken.length;
    stt.onSegment!({ text: 'pickup', isFinal: true });
    await waitFor(() => /Pickup/.test(since(before)));
    expect(since(before)).toContain('ready tomorrow at 6:00 PM, as booked');
    expect(since(before)).not.toMatch(/minutes after the order is placed/);
  });

  it('answers a day too far ahead with the furthest day it can do', async () => {
    const { stt, tts } = await callWith(CLOSED_PROFILE, { scheduleOk: false, refusal: 'too_far' });
    stt.onSegment!({ text: 'how about wednesday at six', isFinal: true });
    await waitFor(() => tts.spoken.join(' ').includes('further ahead'));
    expect(tts.spoken.join(' ')).toContain('The furthest ahead it can do is tomorrow at 6:00 PM');
    expect(tts.spoken.join(' ')).not.toContain('11:20');
  });

  it("tells the model today's date, so a named date is not a guess", async () => {
    const { stt, tts, llm } = await callWith({
      ...CLOSED_PROFILE,
      scheduling: { ...CLOSED_PROFILE.scheduling, today: 'Monday, September 14' },
    });
    stt.onSegment!({ text: 'one large pepperoni', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Added 1 Large Pepperoni/i.test(s)));
    expect(llm.system).toContain('Today is Monday, September 14.');
    expect(llm.system).toContain('weekday name');
  });

  it('answers exactly as before for a location that has not turned any of it on', async () => {
    const { greeting } = await callWith({ name: "Jimmy's", openNow: true, hoursKnown: true });
    expect(greeting()).not.toContain('closed');
    expect(greeting()).toContain("Thanks for calling Jimmy's");
  });
});

describe('withClosedNotice', () => {
  const notice = " We're closed right now. We open again today at 11:00 AM.";
  it('takes the place of the question the greeting ends on', () => {
    expect(
      withClosedNotice(
        "Welcome back, James! Thank you for calling Jimmy's Pizza, Saratoga. This is Jose. What can I get started for you today?",
        notice,
      ),
    ).toBe("Welcome back, James! Thank you for calling Jimmy's Pizza, Saratoga. This is Jose." + notice);
  });
  it('follows a greeting that does not end on a question', () => {
    expect(withClosedNotice("Thanks for calling Jimmy's.", notice)).toBe("Thanks for calling Jimmy's." + notice);
  });
  it('keeps a greeting that is nothing but a question', () => {
    expect(withClosedNotice('How can I help?', notice)).toBe('How can I help?' + notice);
  });
  it('leaves the greeting alone when open', () => {
    expect(withClosedNotice('Hi! How can I help?', '')).toBe('Hi! How can I help?');
  });
});
