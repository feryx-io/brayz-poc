import { describe, expect, it } from 'vitest';
import { DeepgramTtsProvider } from '../src/deepgram-tts.js';

// A slice of Deepgram's real `GET /v1/models` shape (2026-09-07).
const MODELS = {
  tts: [
    {
      name: 'thalia',
      canonical_name: 'aura-2-thalia-en',
      architecture: 'aura-2',
      languages: ['en', 'en-US'],
      metadata: { accent: 'American', age: 'Adult', tags: ['feminine', 'clear', 'confident'], sample: 'https://x/thalia.wav' },
    },
    {
      name: 'apollo',
      canonical_name: 'aura-2-apollo-en',
      architecture: 'aura-2',
      languages: ['en'],
      metadata: { accent: 'American', age: 'Adult', tags: ['masculine', 'confident'] },
    },
    { name: 'agathe', canonical_name: 'aura-2-agathe-fr', architecture: 'aura-2', languages: ['fr'], metadata: {} },
    // First generation: not offered.
    { name: 'asteria', canonical_name: 'aura-asteria-en', architecture: 'aura', languages: ['en'], metadata: {} },
  ],
};

function provider(status = 200) {
  const seen: { url?: string; auth?: string } = {};
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.auth = (init?.headers as Record<string, string>)?.Authorization;
    return new Response(JSON.stringify(MODELS), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { tts: new DeepgramTtsProvider({ apiKey: 'k', fetchImpl }), seen };
}

describe('DeepgramTtsProvider.listVoices', () => {
  it('lists current-generation voices for the language, normalized and sorted by name', async () => {
    const { tts, seen } = provider();
    const voices = await tts.listVoices({ language: 'en' });
    expect(seen.url).toBe('https://api.deepgram.com/v1/models');
    expect(seen.auth).toBe('Token k');
    expect(voices.map((v) => v.id)).toEqual(['aura-2-apollo-en', 'aura-2-thalia-en']);
    expect(voices[1]).toEqual({
      id: 'aura-2-thalia-en',
      name: 'Thalia',
      language: 'en',
      accent: 'American',
      age: 'Adult',
      tags: ['feminine', 'clear', 'confident'],
      sampleUrl: 'https://x/thalia.wav',
    });
  });

  it('lists every language when none is asked for', async () => {
    const { tts } = provider();
    const voices = await tts.listVoices();
    expect(voices.map((v) => v.id)).toContain('aura-2-agathe-fr');
    expect(voices.map((v) => v.id)).not.toContain('aura-asteria-en');
  });

  it('surfaces a failed catalog request instead of an empty list', async () => {
    const { tts } = provider(401);
    await expect(tts.listVoices()).rejects.toThrow(/401/);
  });
});
