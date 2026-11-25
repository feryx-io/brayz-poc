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
import { ConversationEngine } from '../src/conversation.js';

/**
 * "Can I talk to Jose?" — Sarah says she is getting him, and the rest of the
 * call is spoken in Jose's voice with the model answering to his name. Only a
 * listed persona switches; anyone else is a transfer or a message.
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
  spoken: Array<{ text: string; voiceId?: string }> = [];
  async synthesize(opts: { text: string; voiceId?: string; onAudio: (f: AudioFrame) => void }): Promise<void> {
    this.spoken.push({ text: opts.text, voiceId: opts.voiceId });
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
  seen: LlmMessage[][] = [];
  async stream(opts: { messages: LlmMessage[]; onEvent: (e: LlmStreamEvent) => void }): Promise<void> {
    this.seen.push(opts.messages.map((m) => ({ ...m })));
    const step = this.script[this.requests] ?? { text: 'Anything else?' };
    this.requests += 1;
    if (step.text) opts.onEvent({ type: 'text', textDelta: step.text });
    for (const [i, t] of (step.tools ?? []).entries()) {
      opts.onEvent({ type: 'tool_call', toolCall: { id: `t${this.requests}-${i}`, name: t.name, arguments: t.arguments ?? {} } });
    }
    opts.onEvent({ type: 'done' });
  }
}

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
  const tts = new FakeTts();
  const switched: string[] = [];
  const engine = new ConversationEngine({
    providers: { stt, llm, tts },
    context: { callId: 'call-persona', sampleRate: 8000, restaurantName: "Jimmy's Pizza" },
    io: { sendAudio: () => {}, send: () => {} },
    log: pino({ level: 'silent' }),
    loadProfile: async () => ({ name: "Jimmy's Pizza" }),
    loadVoice: async () => ({ voiceId: 'v-sarah', staffName: 'Sarah' }),
    loadPersonas: async () => ['Jose', 'Sarah'],
    switchPersona: async (_ctx, name) => {
      switched.push(name);
      return name === 'Jose' ? { voiceId: 'v-jose', staffName: 'Jose' } : null;
    },
  });
  return { engine, stt, llm, tts, switched };
}

async function say(engine: ConversationEngine, stt: FakeStt, llm: ScriptedLlm, text: string): Promise<void> {
  const before = llm.requests;
  stt.onSegment!({ text, isFinal: true });
  await waitFor(() => llm.requests > before);
  await new Promise((r) => setTimeout(r, 250));
}

describe('Conversation engine — handing the call to another persona', () => {
  it('speaks the hand-off as Sarah and everything after as Jose, answering to his name', async () => {
    const { engine, stt, llm, tts, switched } = buildEngine();
    llm.script = [
      { text: 'Sure, one moment, let me get Jose.', tools: [{ name: 'switch_persona', arguments: { name: 'Jose' } }] },
      { text: 'Hi, this is Jose. What can I do for you?' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    // The greeting is Sarah's, and the model was told who can take the call.
    expect(tts.spoken[0]!.voiceId).toBe('v-sarah');
    expect(tts.spoken[0]!.text).toContain('this is Sarah');

    await say(engine, stt, llm, 'can I talk to Jose');
    await waitFor(() => llm.requests >= 2);
    await new Promise((r) => setTimeout(r, 100));

    expect(switched).toEqual(['Jose']);
    const handoff = tts.spoken.find((s) => s.text.includes('let me get Jose'));
    const asJose = tts.spoken.find((s) => s.text.includes('this is Jose'));
    expect(handoff?.voiceId).toBe('v-sarah');
    expect(asJose?.voiceId).toBe('v-jose');

    const first = llm.seen[0]!.map((m) => m.content);
    expect(first.some((c) => c.includes('Staff who can take the call') && c.includes('- Jose'))).toBe(true);
    const second = llm.seen[1]!;
    expect(second[0]!.content.startsWith("You are Jose, answering calls for Jimmy's Pizza.")).toBe(true);
    expect(second.some((m) => m.role === 'tool' && m.content.includes('You are now Jose'))).toBe(true);
    await engine.stop();
  }, 15_000);

  it('keeps the voice when nobody by that name can take the call', async () => {
    const { engine, stt, llm, tts } = buildEngine();
    llm.script = [
      { text: 'Let me check.', tools: [{ name: 'switch_persona', arguments: { name: 'Maria' } }] },
      { text: 'Maria is not available; I can take a message.' },
    ];
    await engine.start();
    await waitFor(() => stt.onSegment !== undefined);
    await say(engine, stt, llm, 'is Maria there');
    await waitFor(() => llm.requests >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(tts.spoken.every((s) => s.voiceId === 'v-sarah')).toBe(true);
    expect(llm.seen[1]!.some((m) => m.role === 'tool' && m.content.includes('Nobody by that name'))).toBe(true);
    expect(llm.seen[1]![0]!.content.startsWith('You are Sarah')).toBe(true);
    await engine.stop();
  }, 15_000);
});
