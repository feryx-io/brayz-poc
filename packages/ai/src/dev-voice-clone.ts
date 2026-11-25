import type { VoiceCloneProvider } from './providers.js';

/**
 * Local/dev stand-in for a licensed voice-clone vendor (rule #2: providers are
 * abstracted). Returns a deterministic-looking fake voice id without sending
 * audio anywhere. A real adapter (e.g. ElevenLabs) replaces this behind the
 * same interface — consent gating lives in the API, not here.
 */
export class DevVoiceCloneProvider implements VoiceCloneProvider {
  readonly name = 'dev';

  async createVoice(opts: { sampleAudio: Uint8Array[]; label: string }): Promise<{ voiceId: string }> {
    const slug = opts.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const suffix = Math.random().toString(36).slice(2, 8);
    return { voiceId: `dev-voice-${slug || 'unnamed'}-${suffix}` };
  }
}
