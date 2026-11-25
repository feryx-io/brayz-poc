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
import { ConversationEngine } from '../src/conversation.js';

/**
 * Echo suppression. On a real call a caller on speakerphone feeds the agent's
 * own voice back into the mic; Deepgram transcribes it and it arrives as a
 * caller final. Before this guard that aborted the turn that was still
 * speaking — an order readback never reached place_order because the bot kept
 * interrupting itself with its own words (observed on a live call, 2026-08-25).
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
  turns: string[] = [];
  reply = 'Perfect! Let me review your order for you.';
  async stream(opts: {
    messages: { role: string; content: string }[];
    onEvent: (e: LlmStreamEvent) => void;
  }): Promise<void> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user');
    this.turns.push(lastUser?.content ?? '');
    opts.onEvent({ type: 'text', textDelta: this.reply });
    opts.onEvent({ type: 'done' });
  }
}

class FakeTts implements TextToSpeechProvider {
  readonly name = 'fake-tts';
  spoken: string[] = [];
  /** 20 ms frames per utterance — >1 makes playout last long enough to echo into. */
  framesPerUtterance = 1;
  async synthesize(opts: { text: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push(opts.text);
    for (let i = 0; i < this.framesPerUtterance; i++) opts.onAudio(new Uint8Array(320));
  }
}

async function waitFor(pred: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function buildEngine() {
  const stt = new FakeStt();
  const llm = new FakeLlm();
  const tts = new FakeTts();
  const transcript: Array<{ speaker: string; text: string }> = [];
  const sent = { frames: 0 };
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-echo', sampleRate: 8000, restaurantName: "Mario's" },
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
  });
  return { engine, stt, llm, tts, transcript, sent };
}

describe('Conversation engine — self-echo suppression', () => {
  it('ignores its own words coming back through the caller handset', async () => {
    const { engine, stt, llm, tts, transcript } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // The reply is playing out; the handset feeds it back, chopped the way STT
    // chops a played-back sentence — verbatim fragment, then a stray word.
    stt.onSegment!({ text: 'Let me review your order for you. Gray', isFinal: true });

    await new Promise((r) => setTimeout(r, 50));
    // No new turn was started, and the record doesn't credit the guest with our words.
    expect(llm.turns).toEqual(['I would like a large cheese pizza']);
    const callerTurns = transcript.filter((t) => t.speaker === 'caller').map((t) => t.text);
    expect(callerTurns).toEqual(['I would like a large cheese pizza']);
    await engine.stop();
  });

  it('lets a one-word answer through even though we just said that word', async () => {
    // Live call, 2026-08-28. The bot asked "boneless or traditional?"; the
    // caller said "Boneless" and it was dropped as our own voice twice —
    // "boneless" is contained in what we had just said, which is what an answer
    // to a question we asked always is. They said it three times.
    //
    // The cost of the opposite mistake is a short filler of ours ("Perfect")
    // leaking back as one spurious turn, which is why this is the right way
    // round rather than a list of words to exempt.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'Would you like those boneless or traditional?';
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 60; // still playing out when the answer lands
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'let me get some wings', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    stt.onSegment!({ text: 'Boneless.', isFinal: true });

    await waitFor(() => llm.turns.length === 2, 4000);
    expect(llm.turns[1]).toBe('Boneless.');
    expect(transcript.map((t) => t.text)).toContain('Boneless.');
    await engine.stop();
  });

  it('lets the caller choose one of two things we just offered', async () => {
    // Live call, 2026-09-12 23:30. The bot asked "Did you want the Philly Steak
    // sub, or the Philly Steak Pizza?" and the caller said "The the Philly
    // steak sub" — four of those five words a run of our own sentence, so it
    // was dropped as our voice. Fourteen seconds of silence later they asked
    // "Hello?". Short answers were already exempt for exactly this reason; a
    // five-word one fell straight back into the trap that rule was built for.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'Did you want the Philly Steak sub, or the Philly Steak Pizza?';
    await engine.start();
    tts.framesPerUtterance = 60; // still playing out when the answer lands
    await waitFor(() => stt.onSegment !== undefined);
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'philly cheesesteak', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    stt.onSegment!({ text: 'The the Philly steak sub.', isFinal: true });

    await waitFor(() => llm.turns.length === 2, 4000);
    expect(llm.turns[1]).toBe('The the Philly steak sub.');
    expect(transcript.map((t) => t.text)).toContain('The the Philly steak sub.');
    await engine.stop();
  });

  it('still suppresses that question played back with both options in it', async () => {
    // The other side of the line above. An answer picks one alternative; our
    // own question coming back carries both, and is not an answer.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'Did you want the Philly Steak sub, or the Philly Steak Pizza?';
    await engine.start();
    tts.framesPerUtterance = 150;
    await waitFor(() => stt.onSegment !== undefined);
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'philly cheesesteak', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    stt.onSegment!({ text: 'you want the Philly Steak sub or the Philly Steak Pizza', isFinal: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(llm.turns).toEqual(['philly cheesesteak']);
    expect(transcript.filter((t) => t.speaker === 'caller')).toHaveLength(1);
    await engine.stop();
  });

  it('does not take the tail of its own question for an answer', async () => {
    // "or the Philly Steak Pizza" is the end of our sentence coming back, not
    // somebody choosing the pizza — and choosing the wrong item for a caller is
    // worse than the spurious turn a leaked echo costs.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'Did you want the Philly Steak sub, or the Philly Steak Pizza?';
    await engine.start();
    tts.framesPerUtterance = 150;
    await waitFor(() => stt.onSegment !== undefined);
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'philly cheesesteak', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    stt.onSegment!({ text: 'or the Philly Steak Pizza', isFinal: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(llm.turns).toEqual(['philly cheesesteak']);
    expect(transcript.filter((t) => t.speaker === 'caller')).toHaveLength(1);
    await engine.stop();
  });

  it('lets the caller ask about an item using the words we just used', async () => {
    // Live call, 2026-08-28. The bot described the SGT Peppers; the caller asked
    // "Do you have a SGT pizza?" and the guard swallowed it as our own voice —
    // every word of the question was a word we had just said. The caller asked
    // again and again while the bot answered nothing, which is what "it feels
    // out of order" sounds like from the other end of the phone.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'We do have a SGT Peppers pizza with red sauce and sausage.';
    // 60 frames = 1.2 s: still playing out when the question lands, but the
    // queued answer arrives inside the default per-test timeout.
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 60;
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'What is on the menu', isFinal: true });
    // >= 2 is greeting + reply: waiting on the greeting alone would send the
    // "echo" before the line it is supposed to echo had ever been spoken.
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // Shares every word with the reply, and even a three-word run of it
    // ("have a sgt") — but it is a question, not our sentence played back.
    stt.onSegment!({ text: 'Do you have a SGT pizza?', isFinal: true });

    await waitFor(() => llm.turns.length === 2, 4000);
    expect(llm.turns[1]).toBe('Do you have a SGT pizza?');
    expect(transcript.map((t) => t.text)).toContain('Do you have a SGT pizza?');
    await engine.stop();
  });

  it('still suppresses that same reply genuinely echoing back', async () => {
    // The other side of the line above: near-verbatim playback, chopped the way
    // STT chops it. If this stops passing, the fix above went too far.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    llm.reply = 'We do have a SGT Peppers pizza with red sauce and sausage.';
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 150;
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'What is on the menu', isFinal: true });
    // >= 2 is greeting + reply: waiting on the greeting alone would send the
    // "echo" before the line it is supposed to echo had ever been spoken.
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    stt.onSegment!({ text: 'have a SGT Peppers pizza with red sauce', isFinal: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(llm.turns).toEqual(['What is on the menu']);
    expect(transcript.filter((t) => t.speaker === 'caller')).toHaveLength(1);
    await engine.stop();
  });

  it('still lets the caller interrupt with something we did not say', async () => {
    const { engine, stt, llm, tts, transcript } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // Same moment in the call as the echo above — different words, so it lands.
    stt.onSegment!({ text: 'Actually make that two pizzas', isFinal: true });

    await waitFor(() => llm.turns.length === 2);
    expect(llm.turns[1]).toBe('Actually make that two pizzas');
    expect(transcript.map((t) => t.text)).toContain('Actually make that two pizzas');
    await engine.stop();
  });

  it('suppresses an echo arriving while a long reply is still playing out', async () => {
    // The bug this catches: TTS hands over a whole sentence at once, so stamping
    // the echo window at push time expired it while the sentence was still being
    // heard — and the bot interrupted itself two seconds in (live call,
    // 2026-08-25). 150 frames = 3 s of playout at 20 ms/frame.
    const { engine, stt, llm, tts, transcript } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 150;
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // Well past the tail measured from the push, but playout is still going.
    await new Promise((r) => setTimeout(r, 1500));
    stt.onSegment!({ text: 'Let me review your order for you', isFinal: true });

    await new Promise((r) => setTimeout(r, 50));
    expect(llm.turns).toEqual(['I would like a large cheese pizza']);
    expect(transcript.filter((t) => t.speaker === 'caller')).toHaveLength(1);
    await engine.stop();
  });

  it('finishes the turn it is on and answers a mid-turn utterance next', async () => {
    // Background noise (or a caller talking over the bot) used to abort the turn
    // in flight, so an order readback never reached place_order — the bot just
    // restarted itself. The utterance now waits its turn.
    const { engine, stt, llm, tts } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 40; // 800 ms of playout to land inside
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1);
    stt.onSegment!({ text: 'and some garlic knots please', isFinal: true });

    // The first turn ran to completion — it spoke its whole reply (the engine
    // synthesizes sentence by sentence, so join before matching) …
    await waitFor(() => tts.spoken.join(' ').includes('Let me review your order for you.'), 3000);
    // … and only then did the queued utterance become the next turn (the first
    // turn still has two sentences of paced playout to drain before it ends).
    await waitFor(() => llm.turns.length === 2, 4000);
    expect(llm.turns).toEqual([
      'I would like a large cheese pizza',
      'and some garlic knots please',
    ]);
    await engine.stop();
  }, 15_000);

  it('commits the barge-in on an interim, without waiting for a final', async () => {
    // Live call, 2026-08-29: the caller asked "how long?" over the top of a
    // reply and it did not register. A final only lands after Deepgram's
    // endpointing silence plus processing — reliably longer than the
    // confirmation window — so the window expired and playout resumed every
    // time. Six "barge-in unconfirmed" in that one call.
    const { engine, stt, llm, tts, sent } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 200; // 4 s of playout to interrupt
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'what kind of wings do you have', isFinal: true });
    await waitFor(() => llm.turns.length === 1);
    await waitFor(() => sent.frames > 5);

    await engine.bargeIn();
    const atBargeIn = sent.frames;

    // Interim only — no final yet, exactly as it arrives on a real call.
    stt.onSegment!({ text: 'how long', isFinal: false });

    // Well past BARGE_IN_CONFIRM_MS: playout must NOT have resumed.
    await new Promise((r) => setTimeout(r, 1600));
    expect(sent.frames).toBe(atBargeIn);
    await engine.stop();
  }, 15_000);

  it('resumes the reply when a barge-in turns out to be only noise', async () => {
    // The bridge's VAD fires on room noise. Cutting the rest of the reply on
    // every trigger made the bot stutter in and out; playout is held instead and
    // handed back if no words follow.
    const { engine, stt, llm, tts, sent } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 80; // 1.6 s of playout per sentence
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    // Wait for the REPLY to be under way, not just for frames: the greeting
    // alone satisfies sent.frames, so this used to barge in on a turn that had
    // not started, and the interruption merged into the utterance it was
    // interrupting.
    await waitFor(() => llm.turns.length === 1);
    await waitFor(() => sent.frames > 5);

    await engine.bargeIn();
    const atBargeIn = sent.frames;
    await new Promise((r) => setTimeout(r, 400));
    expect(sent.frames).toBe(atBargeIn); // held, not playing

    // Nothing was said, so the reply picks up where it stopped.
    await waitFor(() => sent.frames > atBargeIn, 3000);
    expect(llm.turns).toEqual(['I would like a large cheese pizza']); // turn survived
    await engine.stop();
  }, 15_000);

  it('commits the barge-in when words follow it', async () => {
    const { engine, stt, llm, tts, sent } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 80;
    await waitFor(() => stt.onSegment !== undefined);
    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    // As above: wait for the reply itself, since the greeting alone satisfies
    // sent.frames.
    await waitFor(() => llm.turns.length === 1);
    await waitFor(() => sent.frames > 5);

    await engine.bargeIn();
    stt.onSegment!({ text: 'actually cancel that', isFinal: true });

    await waitFor(() => llm.turns.length === 2, 3000);
    expect(llm.turns[1]).toBe('actually cancel that');
    await engine.stop();
  }, 15_000);

  it('accepts a caller echoing our phrasing once playout is long over', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;

    stt.onSegment!({ text: 'I would like a large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // Past the echo tail: nothing of ours is on the wire, so the guard is off.
    await new Promise((r) => setTimeout(r, 3200));
    stt.onSegment!({ text: 'Let me review your order for you.', isFinal: true });

    await waitFor(() => llm.turns.length === 2);
    expect(llm.turns[1]).toBe('Let me review your order for you.');
    await engine.stop();
  });

  it('answers a bare "no" instead of hearing the "No" we just said ourselves', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    llm.reply = 'No problem at all. Anything else for you today?';
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;
    stt.onSegment!({ text: 'one large cheese pizza', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // The caller answers the question we just asked, inside the echo window and
    // with a word we did just say. Suppressing this leaves them in silence.
    stt.onSegment!({ text: 'No', isFinal: true });
    await waitFor(() => llm.turns.length === 2);
    expect(llm.turns[1]).toBe('No');
    await engine.stop();
  });

  it('matches echo on whole words, not substrings', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    llm.reply = 'That comes with garlic knots.';
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is spoken sentence by sentence, so how many utterances it
    // takes is not something a test should hard-code. Count from there.
    const greeted = tts.spoken.length;
    stt.onSegment!({ text: 'a large pepperoni', isFinal: true });
    await waitFor(() => llm.turns.length === 1 && tts.spoken.length > greeted);

    // "not" is inside "knots" but is not a word we said — a character-level
    // containment test drops it as an echo of our own sentence.
    stt.onSegment!({ text: 'not', isFinal: true });
    await waitFor(() => llm.turns.length === 2);
    expect(llm.turns[1]).toBe('not');
    await engine.stop();
  });
});

/**
 * Live call, 2026-08-28. A slow first reply (cold start) meant the caller asked,
 * heard nothing, and asked again — twice. Each copy was answered separately:
 * "I'm adding a Large Sgt Peppers", then "Anything else?", then "I've ALREADY
 * added one". The latency is fixed elsewhere; a caller repeating themselves is
 * normal on a phone and must not produce a reply each time.
 */
describe('Conversation engine — repeated and fragmented utterances', () => {
  it('answers one sentence once, however many finals STT splits it into', async () => {
    const { engine, stt, llm } = buildEngine();
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);

    // Exactly how it arrived on the call: one sentence, two finals, back to back.
    stt.onSegment!({ text: "I'll take", isFinal: true });
    stt.onSegment!({ text: "I'll take a large one.", isFinal: true });

    await waitFor(() => llm.turns.length === 1, 3000);
    await new Promise((r) => setTimeout(r, 400));
    expect(llm.turns).toHaveLength(1);
    expect(llm.turns[0]).toBe("I'll take I'll take a large one.");
    await engine.stop();
  });

  it('does not answer again when the caller repeats themselves mid-turn', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 60; // reply still playing when the repeat lands
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: "I'll take a large one", isFinal: true });
    await waitFor(() => llm.turns.length === 1, 3000);

    // Same request, said again because the first answer was slow to arrive.
    stt.onSegment!({ text: "I'll I'll take a large one, please.", isFinal: true });

    await new Promise((r) => setTimeout(r, 1500));
    expect(llm.turns).toHaveLength(1);
    await engine.stop();
  });

  it('still answers a genuinely new request that arrives mid-turn', async () => {
    // The guard above must not swallow the caller changing their order.
    const { engine, stt, llm, tts } = buildEngine();
    await engine.start();
    // Set after start(): a long utterance is for the reply, and the greeting
    // playing at that length is dead time in every test that does this.
    tts.framesPerUtterance = 60;
    await waitFor(() => stt.onSegment !== undefined);

    stt.onSegment!({ text: "I'll take a large one", isFinal: true });
    await waitFor(() => llm.turns.length === 1, 3000);

    stt.onSegment!({ text: 'Do you have garlic knots?', isFinal: true });

    await waitFor(() => llm.turns.length === 2, 4000);
    expect(llm.turns[1]).toBe('Do you have garlic knots?');
    await engine.stop();
  });
});
