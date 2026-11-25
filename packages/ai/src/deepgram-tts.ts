/**
 * Deepgram Aura implementation of TextToSpeechProvider (CLAUDE.md rule #2).
 *
 * Synthesizes a text utterance to raw PCM16LE and emits it as fixed-size frames
 * (20 ms by default) so the media layer can pace playback into the call. Streams
 * the HTTP response so first audio arrives before the whole clip is generated;
 * honors AbortSignal for barge-in. Core code talks to TextToSpeechProvider.
 */
import type { AudioFrame, TextToSpeechProvider, TtsVoice } from './providers.js';

export interface DeepgramTtsOptions {
  apiKey: string;
  /** Aura voice model, e.g. aura-2-thalia-en. */
  voice?: string;
  /** Output frame size in milliseconds. */
  frameMs?: number;
  /** Override the base URL (tests / self-hosted). */
  baseUrl?: string;
  /** Override the models catalog URL (tests). */
  modelsUrl?: string;
  /** Inject a fetch (tests). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE = 'https://api.deepgram.com/v1/speak';
const DEFAULT_MODELS = 'https://api.deepgram.com/v1/models';

/** One entry of Deepgram's `GET /v1/models` `tts` list — the fields we read. */
interface DeepgramTtsModel {
  name: string;
  canonical_name: string;
  architecture?: string;
  languages?: string[];
  metadata?: {
    accent?: string | null;
    age?: string | null;
    tags?: string[] | null;
    sample?: string | null;
  };
}

export class DeepgramTtsProvider implements TextToSpeechProvider {
  readonly name = 'deepgram';
  private readonly apiKey: string;
  private readonly voice: string;
  private readonly frameMs: number;
  private readonly baseUrl: string;
  private readonly modelsUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DeepgramTtsOptions) {
    this.apiKey = opts.apiKey;
    this.voice = opts.voice ?? 'aura-2-thalia-en';
    this.frameMs = opts.frameMs ?? 20;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
    this.modelsUrl = opts.modelsUrl ?? DEFAULT_MODELS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * The Aura voices this key can use, from Deepgram's live models catalog —
   * so a voice Deepgram adds shows up without a code change, and one it
   * retires disappears before an owner can pick it. Current-generation
   * (aura-2) voices only: the first generation is on its way out and sounds
   * it. Sorted by name.
   */
  async listVoices(opts: { language?: string } = {}): Promise<TtsVoice[]> {
    const res = await this.fetchImpl(this.modelsUrl, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Deepgram models request failed: ${res.status} ${detail}`.trim());
    }
    const body = (await res.json()) as { tts?: DeepgramTtsModel[] };
    const voices: TtsVoice[] = [];
    for (const m of body.tts ?? []) {
      if (m.architecture !== 'aura-2') continue;
      const language = m.languages?.[0] ?? 'en';
      if (opts.language && language !== opts.language) continue;
      voices.push({
        id: m.canonical_name,
        name: m.name.charAt(0).toUpperCase() + m.name.slice(1),
        language,
        accent: m.metadata?.accent ?? undefined,
        age: m.metadata?.age ?? undefined,
        tags: m.metadata?.tags ?? [],
        sampleUrl: m.metadata?.sample ?? undefined,
      });
    }
    return voices.sort((a, b) => a.name.localeCompare(b.name));
  }

  async synthesize(opts: {
    text: string;
    voiceId?: string;
    sampleRate: number;
    onAudio: (frame: AudioFrame) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const params = new URLSearchParams({
      model: opts.voiceId ?? this.voice,
      encoding: 'linear16',
      sample_rate: String(opts.sampleRate),
      container: 'none', // raw PCM, no WAV header
    });

    const res = await this.fetchImpl(`${this.baseUrl}?${params.toString()}`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: opts.text }),
      signal: opts.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Deepgram TTS failed: ${res.status} ${detail}`.trim());
    }

    // 16-bit mono: 2 bytes per sample.
    const bytesPerFrame = Math.round((opts.sampleRate * this.frameMs) / 1000) * 2;
    const reader = res.body.getReader();
    let carry = new Uint8Array(0);

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.length === 0) continue;

        let buf = carry.length ? concat(carry, value) : value;
        let offset = 0;
        while (buf.length - offset >= bytesPerFrame) {
          opts.onAudio(buf.subarray(offset, offset + bytesPerFrame));
          offset += bytesPerFrame;
        }
        carry = buf.subarray(offset);
      }
      // Flush any trailing partial frame so we don't clip the tail of speech.
      if (carry.length > 0) opts.onAudio(carry);
    } catch (err) {
      if (opts.signal?.aborted) return; // barge-in cancelled playback — expected
      throw err;
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
