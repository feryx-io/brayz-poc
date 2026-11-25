/**
 * Deepgram implementation of SpeechToTextProvider (CLAUDE.md rule #2).
 *
 * Streaming live transcription over Deepgram's WebSocket API. Caller PCM16LE
 * frames are pushed in; interim + final transcript segments come out. Core code
 * talks to SpeechToTextProvider, never to this class directly.
 */
import WebSocket from 'ws';
import type {
  AudioFrame,
  SpeechToTextProvider,
  SttStreamHandle,
  TranscriptSegment,
} from './providers.js';

export interface DeepgramSttOptions {
  apiKey: string;
  /** Deepgram model. nova-3 is a strong default; nova-2-phonecall suits 8 kHz telephony. */
  model?: string;
  /** Override the base URL (tests / self-hosted). */
  baseUrl?: string;
}

const DEFAULT_BASE = 'wss://api.deepgram.com/v1/listen';

export class DeepgramSttProvider implements SpeechToTextProvider {
  readonly name = 'deepgram';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;

  constructor(opts: DeepgramSttOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'nova-3';
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE;
  }

  async openStream(opts: {
    sampleRate: number;
    onSegment: (segment: TranscriptSegment) => void;
    onError?: (err: Error) => void;
  }): Promise<SttStreamHandle> {
    const params = new URLSearchParams({
      encoding: 'linear16',
      sample_rate: String(opts.sampleRate),
      channels: '1',
      model: this.model,
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      // End-of-utterance silence (ms) so finals land promptly for turn-taking.
      endpointing: '300',
    });

    const ws = new WebSocket(`${this.baseUrl}?${params.toString()}`, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    ws.on('message', (data: WebSocket.RawData) => {
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type !== 'Results' || !msg.channel) return;
      const alt = msg.channel.alternatives?.[0];
      const text = alt?.transcript?.trim();
      if (!text) return;
      opts.onSegment({
        text,
        isFinal: msg.is_final === true,
        confidence: alt?.confidence,
        startedAtMs: msg.start != null ? Math.round(msg.start * 1000) : undefined,
        endedAtMs:
          msg.start != null && msg.duration != null
            ? Math.round((msg.start + msg.duration) * 1000)
            : undefined,
      });
    });

    if (opts.onError) ws.on('error', (err) => opts.onError!(err as Error));

    await waitForOpen(ws);

    let closed = false;
    return {
      pushAudio(frame: AudioFrame): void {
        if (closed || ws.readyState !== WebSocket.OPEN) return;
        ws.send(frame);
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (ws.readyState === WebSocket.OPEN) {
          // Ask Deepgram to flush remaining audio, then close.
          ws.send(JSON.stringify({ type: 'CloseStream' }));
        }
        ws.close();
      },
    };
  }
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  start?: number;
  duration?: number;
  channel?: {
    alternatives?: Array<{ transcript?: string; confidence?: number }>;
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err as Error));
  });
}
