import { DeepgramTtsProvider, type TextToSpeechProvider, type TtsVoice } from '@brayz/ai';
import { loadConfig } from '@brayz/config';

/**
 * The TTS provider the dashboard lists and previews voices with — the same
 * vendor the Orchestrator speaks with, so what an owner hears in the browser
 * is what a caller hears. Null when no key is configured: the catalog is then
 * empty and previews are refused, never faked. Tests inject a fake.
 */
export function buildTts(): TextToSpeechProvider | null {
  const cfg = loadConfig();
  if (!cfg.DEEPGRAM_API_KEY) return null;
  return new DeepgramTtsProvider({ apiKey: cfg.DEEPGRAM_API_KEY });
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
const catalogs = new WeakMap<TextToSpeechProvider, { at: number; voices: TtsVoice[] }>();

/**
 * The provider's English voices, cached an hour per provider instance: the
 * catalog changes rarely and every settings page load would otherwise hit
 * the vendor. Empty when the provider cannot list.
 */
export async function voiceCatalog(tts: TextToSpeechProvider | null): Promise<TtsVoice[]> {
  if (!tts?.listVoices) return [];
  const cached = catalogs.get(tts);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.voices;
  const voices = await tts.listVoices({ language: 'en' });
  catalogs.set(tts, { at: Date.now(), voices });
  return voices;
}

/** Wrap raw PCM16LE mono frames in a WAV header so a browser can play them. */
export function pcm16ToWav(frames: Uint8Array[], sampleRate: number): Buffer {
  const dataLength = frames.reduce((n, f) => n + f.length, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);
  return Buffer.concat([header, ...frames.map((f) => Buffer.from(f))]);
}
