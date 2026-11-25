import type { FastifyInstance } from 'fastify';
import type { TextToSpeechProvider } from '@brayz/ai';
import { VoicePreviewInput } from '@brayz/shared';
import { prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import { buildTts, pcm16ToWav, voiceCatalog } from '../lib/tts.js';

export interface VoiceRouteOptions {
  /** The TTS provider to list and preview with. `null` means none configured; tests inject a fake. */
  tts?: TextToSpeechProvider | null;
}

/** A browser plays this fine and it is what Aura is happiest producing. */
const PREVIEW_SAMPLE_RATE = 24_000;

/**
 * The voices an owner can pick for the built-in receptionist, and a way to
 * hear one before choosing. The catalog comes from the TTS provider (rule #2 —
 * a different vendor lists its own), cached for an hour since it changes
 * rarely and every settings page load would otherwise hit the vendor.
 */
export async function voiceRoutes(app: FastifyInstance, opts: VoiceRouteOptions = {}): Promise<void> {
  const tts = opts.tts === undefined ? buildTts() : opts.tts;

  app.get('/v1/voices', async (request) => {
    requireTenant(request);
    return { provider: tts?.name ?? null, voices: await voiceCatalog(tts) };
  });

  // Speak one line in one voice, as WAV. Manager+: it costs vendor money.
  app.post('/v1/locations/:locationId/voices/preview', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const loc = await prisma.location.findFirst({ where: { id: locationId, tenantId }, select: { id: true } });
    if (!loc) throw notFound('Location');
    if (!tts) throw new HttpError(503, 'Voice preview is not configured', 'tts_not_configured');
    const input = parse(VoicePreviewInput, request.body);
    const frames: Uint8Array[] = [];
    await tts.synthesize({
      text: input.text,
      voiceId: input.voiceId,
      sampleRate: PREVIEW_SAMPLE_RATE,
      onAudio: (f) => frames.push(f),
    });
    const wav = pcm16ToWav(frames, PREVIEW_SAMPLE_RATE);
    return reply.header('content-type', 'audio/wav').header('cache-control', 'no-store').send(wav);
  });
}
