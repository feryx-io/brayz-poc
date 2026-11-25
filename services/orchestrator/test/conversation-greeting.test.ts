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
import { ConversationEngine, type GuestInfo } from '../src/conversation.js';

/**
 * What the model is told about the greeting. The greeting is spoken by us, not
 * generated — and until it was written down, the model's first reply opened by
 * greeting the caller all over again ("Welcome back, James!" from here, then
 * "Hey James, welcome back!" from the model, on the call of 2026-09-02).
 */
class FakeStt implements SpeechToTextProvider {
  readonly name = 'fake-stt';
  onSegment?: (s: TranscriptSegment) => void;
  async openStream(opts: { onSegment: (s: TranscriptSegment) => void }): Promise<SttStreamHandle> {
    this.onSegment = opts.onSegment;
    return { pushAudio() {}, async close() {} };
  }
}

class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  calls = 0;
  /** The history as of the most recent request. */
  seen: LlmMessage[] = [];
  async stream(opts: {
    messages: LlmMessage[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    this.calls += 1;
    this.seen = opts.messages.map((m) => ({ ...m }));
    opts.onEvent({ type: 'text', textDelta: 'Sure thing.' });
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  framesPerUtterance = 1;
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    for (let i = 0; i < this.framesPerUtterance; i++) opts.onAudio(new Uint8Array(320));
  }
}

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine(
  guest?: GuestInfo,
  profile?: { name?: string; greeting?: string | null; welcomeBack?: string | null },
  voice?: { voiceId?: string | null; staffName?: string | null },
) {
  const stt = new FakeStt();
  const llm = new FakeLlm();
  const tts = new FakeTts();
  const transcript: Array<{ speaker: string; text: string }> = [];
  const sent = { frames: 0 };
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-greet', sampleRate: 8000, restaurantName: "Jimmy's Pizza" },
    io: {
      sendAudio: () => {
        sent.frames += 1;
      },
      send: () => {},
    },
    log: pino({ level: 'silent' }),
    onTranscript: (segment, speaker) => {
      if (segment.isFinal) transcript.push({ speaker, text: segment.text });
    },
    ...(guest ? { loadGuest: async () => guest } : {}),
    ...(profile ? { loadProfile: async () => profile } : {}),
    ...(voice ? { loadVoice: async () => voice } : {}),
  });
  return { engine, stt, llm, tts, transcript, sent };
}

const OWNER_GREETING =
  "Thank you for calling Jimmy's Pizza, Saratoga. This is Sam, your digital ordering assistant. What can I get started for you today?";

describe('Conversation engine — the greeting the model did not write', () => {
  it('tells the model what it already said, and never as the opening message', async () => {
    const { engine, stt, llm, transcript } = buildEngine({
      isReturning: true,
      displayName: 'James',
      mode: 'full',
    });
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'can I get a sausage pizza', isFinal: true });
    await waitFor(() => llm.calls === 1);

    // The model is told the greeting happened, in its own words.
    const told = llm.seen.filter((m) => m.role === 'system').map((m) => m.content);
    expect(told.some((c) => c.includes('Welcome back, James!'))).toBe(true);
    expect(told.some((c) => /do not greet them/i.test(c))).toBe(true);

    // As a system line, not an assistant turn: the Messages API rejects a
    // conversation whose first message is not the caller's.
    const conversation = llm.seen.filter((m) => m.role !== 'system');
    expect(conversation[0]!.role).toBe('user');

    // And it is in the call record, once.
    const agent = transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
    expect(agent.filter((t) => t.includes('Welcome back, James!'))).toHaveLength(1);
    await engine.stop();
  }, 15_000);

  it('reports only the part of a greeting the caller talked over', async () => {
    const { engine, stt, tts, transcript, sent } = buildEngine({
      isReturning: true,
      displayName: 'James',
      mode: 'full',
    });
    tts.framesPerUtterance = 80; // 1.6 s a sentence — slow enough to interrupt
    const started = engine.start();
    await waitFor(() => sent.frames > 3); // into the first sentence of the greeting

    await engine.bargeIn();
    stt.onSegment!({ text: 'hello', isFinal: true });
    await started;

    // "Welcome back, James!" had started playing; the rest was still in the
    // pump, so the record must not claim the caller heard it.
    const agent = transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
    expect(agent).toHaveLength(1);
    expect(agent[0]).toContain('Welcome back, James!');
    expect(agent[0]).not.toContain('How can I help you today?');
    expect(agent[0]!.endsWith('…')).toBe(true);
    await engine.stop();
  }, 15_000);

  it('records nothing when the greeting never reached the caller at all', async () => {
    // Nothing played, so there is nothing to say we said — a transcript that
    // opens with a greeting the caller never heard is a false record.
    const { engine, transcript, tts } = buildEngine();
    tts.framesPerUtterance = 0;
    await engine.start();
    expect(transcript.filter((t) => t.speaker === 'agent')).toHaveLength(0);
    await engine.stop();
  }, 15_000);
});

describe('Conversation engine — what a recognized guest is not asked for', () => {
  async function systemPromptFor(guest: GuestInfo): Promise<string> {
    const { engine, stt, llm } = buildEngine(guest);
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'that is all', isFinal: true });
    await waitFor(() => llm.calls === 1);
    await engine.stop();
    return llm.seen
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n');
  }

  it('gives the model the name to put the order under', async () => {
    // James was greeted by name and then asked what name to put the order
    // under (2026-09-02). We already knew.
    const prompt = await systemPromptFor({ isReturning: true, displayName: 'James', mode: 'full' });
    expect(prompt).toContain('Their name is James');
    expect(prompt).toMatch(/do not ask them what name/i);
  }, 15_000);

  it('still asks in confirm-first mode, where the name is the identity check', async () => {
    const prompt = await systemPromptFor({
      isReturning: true,
      displayName: 'James',
      mode: 'confirm',
    });
    expect(prompt).not.toContain('Their name is James');
    expect(prompt).toMatch(/confirm who is calling/i);
  }, 15_000);

  it("speaks the owner's greeting from Settings word for word", async () => {
    const { engine, stt, tts, llm, transcript } = buildEngine(undefined, {
      name: "Jimmy's Pizza - Saratoga",
      greeting: OWNER_GREETING,
    });
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // TTS is fed a sentence at a time; together they are the owner's words exactly.
    expect(tts.spoken.join(' ')).toBe(OWNER_GREETING);
    const agent = transcript.filter((t) => t.speaker === 'agent').map((t) => t.text);
    expect(agent[0]).toBe(OWNER_GREETING);

    // The model is told the persona the owner chose.
    stt.onSegment!({ text: 'hi Sam', isFinal: true });
    await waitFor(() => llm.calls === 1);
    const system = llm.seen.filter((m) => m.role === 'system').map((m) => m.content);
    expect(system.some((c) => c.includes('This is Sam') && c.includes('your name on this call'))).toBe(true);
    await engine.stop();
  }, 15_000);

  it("welcomes a recognized regular by name, then the owner's greeting", async () => {
    const { engine, stt, tts } = buildEngine(
      { isReturning: true, displayName: 'James', mode: 'full' },
      { name: "Jimmy's Pizza - Saratoga", greeting: OWNER_GREETING },
    );
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe(`Welcome back, James! ${OWNER_GREETING}`);
    await engine.stop();
  }, 15_000);

  it('falls back to the default greeting when the owner left theirs blank', async () => {
    const { engine, stt, tts } = buildEngine(undefined, { name: "Jimmy's Pizza - Saratoga", greeting: '   ' });
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe("Thanks for calling Jimmy's Pizza - Saratoga. How can I help you today?");
    await engine.stop();
  }, 15_000);

  it("fills {staff_name} with the default voice's name, and the model answers to it", async () => {
    const { engine, stt, tts, llm } = buildEngine(
      undefined,
      { name: "Jimmy's Pizza", greeting: "Thanks for calling Jimmy's Pizza. This is {staff_name}, your digital assistant." },
      { voiceId: 'aura-2-apollo-en', staffName: 'Sam' },
    );
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe("Thanks for calling Jimmy's Pizza. This is Sam, your digital assistant.");

    stt.onSegment!({ text: 'hi', isFinal: true });
    await waitFor(() => llm.calls === 1);
    const system = llm.seen.filter((m) => m.role === 'system').map((m) => m.content);
    expect(system.some((c) => c.startsWith("You are Sam, answering calls for Jimmy's Pizza."))).toBe(true);
    await engine.stop();
  }, 15_000);

  it('fills {staff_name} with Brayz when no name was given', async () => {
    const { engine, stt, tts } = buildEngine(undefined, {
      name: "Jimmy's Pizza",
      greeting: 'Hi, this is {staff_name}.',
    });
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe('Hi, this is Brayz.');
    await engine.stop();
  }, 15_000);

  it("welcomes a regular with the line chosen for this call, then the greeting chosen for it", async () => {
    const { engine, stt, tts } = buildEngine(
      { isReturning: true, displayName: 'James', mode: 'full' },
      { name: "Jimmy's Pizza", greeting: 'Jimmy\'s Pizza, {staff_name} speaking.', welcomeBack: 'Hey {guest_name}, good to hear from you!' },
      { staffName: 'Sam' },
    );
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe("Hey James, good to hear from you! Jimmy's Pizza, Sam speaking.");
    await engine.stop();
  }, 15_000);

  it('uses the chosen welcome-back line with the default greeting too', async () => {
    const { engine, stt, tts } = buildEngine(
      { isReturning: true, displayName: 'James', mode: 'full' },
      { name: "Jimmy's Pizza", welcomeBack: '{guest_name}! Good to have you back.' },
    );
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    expect(tts.spoken.join(' ')).toBe("James! Good to have you back. Thanks for calling Jimmy's Pizza. How can I help you today?");
    await engine.stop();
  }, 15_000);
});
