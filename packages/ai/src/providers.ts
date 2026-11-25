/**
 * Provider interfaces (CLAUDE.md rule #2). Core code talks to these, never to a
 * vendor SDK. A new vendor is a new adapter in this package — no changes to
 * call/order/guest logic. Concrete adapters (Deepgram, OpenAI, ElevenLabs, …)
 * land in Phase 3.
 */

/** PCM16LE mono audio frame, typically 20 ms @ 8 kHz from the carrier. */
export type AudioFrame = Uint8Array;

export interface TranscriptSegment {
  text: string;
  isFinal: boolean;
  confidence?: number;
  startedAtMs?: number;
  endedAtMs?: number;
}

/** Streaming speech-to-text. */
export interface SpeechToTextProvider {
  readonly name: string;
  /**
   * Open a streaming session. Push caller audio frames in; receive transcript
   * segments via `onSegment`. Returns a handle to push audio and close.
   */
  openStream(opts: {
    sampleRate: number;
    onSegment: (segment: TranscriptSegment) => void;
    onError?: (err: Error) => void;
  }): Promise<SttStreamHandle>;
}

export interface SttStreamHandle {
  pushAudio(frame: AudioFrame): void;
  close(): Promise<void>;
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** For role 'tool': the id of the assistant tool call this message answers. */
  toolCallId?: string;
  /** For role 'assistant': tool calls the assistant made on this turn. */
  toolCalls?: LlmToolCall[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments. */
  parameters: Record<string, unknown>;
}

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmStreamEvent {
  /**
   * `start` — the first content of the answer has begun (a word, or a tool
   * call whose arguments are still streaming), so a caller's wait can be
   * measured to the model's first byte rather than to a finished tool call.
   * `usage` — what the request cost and whether the prompt cache served it.
   * Both are optional for a provider to send.
   */
  type: 'text' | 'tool_call' | 'done' | 'start' | 'usage';
  textDelta?: string;
  toolCall?: LlmToolCall;
  usage?: LlmUsage;
}

/** Token accounting for one model request, as far as the provider reports it. */
export interface LlmUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** The provider's id for the request, for chasing a slow one with them. */
  requestId?: string | null;
}

/** Streaming chat LLM with tool-calling. */
export interface LlmProvider {
  readonly name: string;
  stream(opts: {
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    temperature?: number;
    onEvent: (event: LlmStreamEvent) => void;
    signal?: AbortSignal;
  }): Promise<void>;
}

/** A voice a TTS provider can speak with, normalized across vendors. */
export interface TtsVoice {
  /** Provider voice id — what `synthesize({ voiceId })` takes. */
  id: string;
  /** Display name, e.g. "Asteria". */
  name: string;
  /** BCP-47-ish language, e.g. "en". */
  language: string;
  /** e.g. "American", "British". */
  accent?: string;
  /** e.g. "Adult", "Young Adult", "Mature". */
  age?: string;
  /** Free-form vendor descriptors — "feminine", "warm", "professional". */
  tags: string[];
  /** Vendor-hosted sample clip, if any. */
  sampleUrl?: string;
}

/** Streaming text-to-speech producing PCM frames for playback into the call. */
export interface TextToSpeechProvider {
  readonly name: string;
  synthesize(opts: {
    text: string;
    voiceId?: string;
    sampleRate: number;
    onAudio: (frame: AudioFrame) => void;
    signal?: AbortSignal;
  }): Promise<void>;
  /** The voices on offer (optional — a fixed-voice provider has none to list). */
  listVoices?(opts?: { language?: string }): Promise<TtsVoice[]>;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Voice cloning — consent-gated (CLAUDE.md rule #6); Phase 7. */
export interface VoiceCloneProvider {
  readonly name: string;
  createVoice(opts: { sampleAudio: AudioFrame[]; label: string }): Promise<{ voiceId: string }>;
}
