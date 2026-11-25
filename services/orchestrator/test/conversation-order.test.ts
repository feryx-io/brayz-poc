import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pino from 'pino';
import { WebSocket } from 'ws';
import type {
  AudioFrame,
  LlmProvider,
  LlmStreamEvent,
  SpeechToTextProvider,
  SttStreamHandle,
  TextToSpeechProvider,
  TranscriptSegment,
} from '@brayz/ai';
import { createMediaServer, type ConversationFactory, type MediaServerHandle } from '../src/mediaServer.js';
import { ConversationEngine, type MenuItemInfo, type OrderLine } from '../src/conversation.js';
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
  voiceIds: Array<string | undefined> = [];
  async synthesize(opts: { text: string; voiceId?: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    this.voiceIds.push(opts.voiceId);
    opts.onAudio(new Uint8Array(320));
  }
}
/**
 * Drives an order: one tool call per user turn, then relays the tool result as
 * spoken text (what a real LLM does), so the test can assert the spoken result.
 */
class OrderLlm implements LlmProvider {
  readonly name = 'fake-llm';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const msgs = opts.messages;
    const last = msgs[msgs.length - 1];
    if (last.role === 'tool') {
      for (const ch of last.content.match(/[\s\S]{1,8}/g) ?? []) opts.onEvent({ type: 'text', textDelta: ch });
      opts.onEvent({ type: 'done' });
      return;
    }
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (/^yes|go ahead/i.test(lastUser?.content ?? '')) {
      opts.onEvent({
        type: 'tool_call',
        toolCall: {
          id: 'p1',
          name: 'place_order',
          arguments: { customer_name: 'Sam', redeem_reward: true },
        },
      });
    } else if (/place|under|that'?s it/i.test(lastUser?.content ?? '')) {
      // The order is read back first — the engine will not place one in the
      // same turn it was read back in.
      opts.onEvent({ type: 'tool_call', toolCall: { id: 'r1', name: 'review_order', arguments: { customer_name: 'Sam' } } });
    } else {
      opts.onEvent({
        type: 'tool_call',
        toolCall: { id: 'a1', name: 'add_item', arguments: { item: 'Large Pepperoni', quantity: 2 } },
      });
    }
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

describe('Conversation engine — order taking', () => {
  let media: MediaServerHandle;
  let port: number;
  let stt: FakeStt;
  let tts: FakeTts;
  let placed:
    | { lines: OrderLine[]; opts: { customerName?: string; redeemReward?: boolean } }
    | undefined;
  let refuse: { code: string; message: string } | undefined;

  beforeAll(async () => {
    stt = new FakeStt();
    tts = new FakeTts();
    placed = undefined;
    const factory: ConversationFactory = ({ context, io, log }) =>
      new ConversationEngine({
        providers: { stt, llm: new OrderLlm(), tts },
        context,
        io,
        log,
        loadMenu: async () => MENU,
        // Asserts on what the tool says back to the model, which only reaches the
        // caller when the location has asked the AI to word confirmations.
        loadProfile: async () => ({ orderAckMode: 'natural' as const }),
        loadVoice: async () => ({ voiceId: 'test-voice-tony', staffName: 'Tony' }),
        placeOrder: async (_ctx, lines, opts) => {
          placed = { lines, opts };
          if (refuse) return { refused: refuse };
          return { orderCode: 'ABCDE', totalCents: 3300, discountCents: 300 };
        },
      });
    media = createMediaServer({
      log: pino({ level: 'silent' }),
      persistence: new SpyPersistence(),
      nodeId: 'test',
      conversationFactory: factory,
    });
    port = await media.listen(0);
  });
  afterAll(async () => {
    await media.close();
  });

  it('adds a menu item priced from the menu, then places the order via placeOrder', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-order1',
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );

    await waitFor(() => stt.onSegment !== undefined && tts.spoken.length >= 1); // greeting done

    // The staff persona answers: named in the greeting, synthesized with its voice.
    expect(tts.spoken[0]).toContain('this is Tony');
    expect(tts.voiceIds[0]).toBe('test-voice-tony');

    // Turn 1: add two pepperonis. The engine prices from the menu (2 × $18 = $36).
    stt.onSegment!({ text: 'I would like two large pepperonis', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now \$36\.00/i.test(s)));
    expect(tts.spoken.some((s) => s.includes('Large Pepperoni'))).toBe(true);

    // Turn 2: the read-back.
    stt.onSegment!({ text: "that's it, place it under Sam", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));

    // Turn 3: the caller answers it, and only then is the order placed.
    stt.onSegment!({ text: 'yes, go ahead', isFinal: true });
    await waitFor(() => placed !== undefined);

    expect(placed!.opts.customerName).toBe('Sam');
    expect(placed!.opts.redeemReward).toBe(true); // redeem_reward passed through to the API
    expect(placed!.lines).toMatchObject([
      { menuItemId: 'mi-1', name: 'Large Pepperoni', quantity: 2, unitPriceCents: 1800 },
    ]);

    // The success confirmation (code + authoritative total + reward) is spoken back.
    await waitFor(() => tts.spoken.some((s) => /Confirmation code A B C D E/.test(s)));
    expect(tts.spoken.some((s) => /\$33\.00/.test(s))).toBe(true);
    expect(tts.spoken.some((s) => /loyalty reward of \$3\.00/i.test(s))).toBe(true);

    ws.close();
  });

  it('takes an option the API refuses back to the caller instead of giving up', async () => {
    placed = undefined;
    refuse = { code: 'modifier_required', message: 'Large Pepperoni needs a Crust choice' };
    tts.spoken = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/media`);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(
      JSON.stringify({
        type: 'start',
        version: '1',
        call_id: 'siphon-order2',
        seq: 0,
        to: '+15185550123',
        direction: 'inbound',
        audio: { encoding: 'pcm16le', sample_rate: 8000, channels: 1, frame_ms: 20 },
      }),
    );
    await waitFor(() => stt.onSegment !== undefined && tts.spoken.length >= 1);
    stt.onSegment!({ text: 'I would like two large pepperonis', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /order total is now/i.test(s)));
    stt.onSegment!({ text: "that's it, place it under Sam", isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /Current order/.test(s)));
    stt.onSegment!({ text: 'yes, go ahead', isFinal: true });
    await waitFor(() => tts.spoken.some((s) => /needs a Crust choice/.test(s)));
    expect(tts.spoken.some((s) => /could not submit/i.test(s))).toBe(false);
    refuse = undefined;
    ws.close();
  });
});
