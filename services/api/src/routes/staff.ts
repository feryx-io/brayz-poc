import type { FastifyInstance } from 'fastify';
import type { VoiceCloneProvider } from '@brayz/ai';
import { DevVoiceCloneProvider } from '@brayz/ai';
import {
  AssignProviderVoiceInput,
  SwitchPersonaInput,
  CreateStaffInput,
  CreateVoiceProfileInput,
  RecordConsentInput,
  UpdateStaffInput,
  UpdateVoiceProfileInput,
} from '@brayz/shared';
import { forTenant, prisma, writeAudit } from '@brayz/db';
import { buildTts, voiceCatalog } from '../lib/tts.js';
import type { TextToSpeechProvider } from '@brayz/ai';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireNode } from '../auth/node.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import { requireEntitlement } from '../lib/billing.js';

export interface StaffRouteOptions {
  /** The TTS provider whose catalog voices a persona may be given. `null` = none; tests inject a fake. */
  tts?: TextToSpeechProvider | null;
  /** Inject a cloner (tests). Default: the dev stand-in (no real vendor yet). */
  voiceCloner?: VoiceCloneProvider;
}

/**
 * Staff voice personas (Phase 7). The non-negotiables (CLAUDE.md rule #6) are
 * enforced here, in code: no voice profile exists without an explicit, recorded
 * consent grant; consent is an append-only ledger (timestamp + source + who
 * recorded it); revocation immediately retires every voice for that staff
 * member; consent changes and voice lifecycle are audited.
 */
export async function staffRoutes(app: FastifyInstance, opts: StaffRouteOptions = {}): Promise<void> {
  const tts = opts.tts === undefined ? buildTts() : opts.tts;

  /** The catalog voice with this id, or a 422/503 that says why not. */
  async function catalogVoice(voiceId: string) {
    if (!tts) throw new HttpError(503, 'Voice catalog is not configured', 'tts_not_configured');
    const voice = (await voiceCatalog(tts)).find((v) => v.id === voiceId);
    if (!voice) throw new HttpError(422, 'That voice is not in the catalog', 'unknown_voice');
    return voice;
  }

  /** A ready catalog-voice profile for a persona: nobody's real voice, so no consent is involved. */
  async function assignProviderVoice(
    tenantId: string,
    staff: { id: string; locationId: string },
    voiceId: string,
    label: string | undefined,
    actorId: string | null,
  ) {
    const voice = await catalogVoice(voiceId);
    // A persona has one catalog voice: choosing another swaps it in place, so
    // the rotation flag and the fixed-voice setting that point at this
    // profile keep working and nothing piles up.
    const current = await prisma.staffVoiceProfile.findFirst({
      where: { staffProfileId: staff.id, source: 'provider' },
      select: { id: true, providerVoiceId: true },
    });
    const data = {
      label: label ?? voice.name,
      status: 'ready',
      source: 'provider',
      provider: tts!.name,
      providerVoiceId: voice.id,
    };
    const profile = current
      ? await prisma.staffVoiceProfile.update({ where: { id: current.id }, data })
      : await prisma.staffVoiceProfile.create({ data: { ...data, tenantId, staffProfileId: staff.id } });
    await writeAudit({
      tenantId,
      locationId: staff.locationId,
      actorId,
      action: current ? 'voice.profile.changed' : 'voice.profile.created',
      targetType: 'staff_voice',
      targetId: profile.id,
      metadata: { staffId: staff.id, provider: tts!.name, source: 'provider', voiceId: voice.id, previousVoiceId: current?.providerVoiceId ?? null },
    });
    return profile;
  }

  const cloner = opts.voiceCloner ?? new DevVoiceCloneProvider();

  // ---- Staff CRUD (dashboard, manager-gated writes) ----

  app.get('/v1/locations/:locationId/staff', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const db = forTenant(tenantId);
    const staff = await db.staffProfile.findMany({
      where: { locationId },
      orderBy: { createdAt: 'asc' },
      include: {
        voiceProfiles: { orderBy: { createdAt: 'asc' } },
        consentRecords: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return staff.map((s) => ({
      id: s.id,
      name: s.name,
      role: s.role,
      active: s.active,
      createdAt: s.createdAt,
      consent: s.consentRecords[0]
        ? {
            action: s.consentRecords[0].action,
            source: s.consentRecords[0].source,
            at: s.consentRecords[0].createdAt,
          }
        : null,
      voiceProfiles: s.voiceProfiles.map((v) => ({
        id: v.id,
        label: v.label,
        status: v.status,
        source: v.source,
        provider: v.provider,
        // A catalog voice is previewable by id; a clone's vendor id stays private.
        providerVoiceId: v.source === 'provider' ? v.providerVoiceId : null,
        enabledForRotation: v.enabledForRotation,
      })),
    }));
  });

  app.post('/v1/locations/:locationId/staff', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const { providerVoiceId, ...input } = parse(CreateStaffInput, request.body);
    // Validate the voice before creating the person, so a typo leaves nothing behind.
    if (providerVoiceId) await catalogVoice(providerVoiceId);
    const db = forTenant(tenantId);
    const staff = await db.staffProfile.create({ data: { ...input, locationId, tenantId } });
    if (providerVoiceId) {
      await assignProviderVoice(tenantId, staff, providerVoiceId, undefined, request.auth?.userId ?? null);
    }
    return reply.status(201).send(staff);
  });

  // Give an existing persona a catalog voice (manager+). No consent gate: it is
  // the vendor's voice, not a person's.
  app.post('/v1/staff/:staffId/voice/provider', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { staffId } = request.params as { staffId: string };
    const input = parse(AssignProviderVoiceInput, request.body);
    const db = forTenant(tenantId);
    const staff = await db.staffProfile.findFirst({ where: { id: staffId }, select: { id: true, locationId: true } });
    if (!staff) throw notFound('Staff member');
    const profile = await assignProviderVoice(tenantId, staff, input.voiceId, input.label, request.auth?.userId ?? null);
    return reply.status(201).send(profile);
  });

  app.patch('/v1/staff/:staffId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { staffId } = request.params as { staffId: string };
    const input = parse(UpdateStaffInput, request.body);
    const db = forTenant(tenantId);
    const existing = await db.staffProfile.findFirst({ where: { id: staffId }, select: { id: true } });
    if (!existing) throw notFound('Staff member');
    return db.staffProfile.update({ where: { id: staffId }, data: input });
  });

  app.delete('/v1/staff/:staffId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { staffId } = request.params as { staffId: string };
    const db = forTenant(tenantId);
    const existing = await db.staffProfile.findFirst({
      where: { id: staffId },
      select: { id: true, locationId: true },
    });
    if (!existing) throw notFound('Staff member');
    await db.staffProfile.delete({ where: { id: staffId } }); // voices + consent cascade
    await writeAudit({
      tenantId,
      locationId: existing.locationId,
      action: 'staff.deleted',
      targetType: 'staff',
      targetId: staffId,
    });
    return reply.status(204).send();
  });

  // ---- Consent ledger (append-only; the sensitive part) ----

  app.post('/v1/staff/:staffId/consent', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    // Consent provenance: resolve the recording user even under dev header auth
    // (which carries only an email) — "who recorded it" is part of the record.
    let actorId = request.auth?.userId ?? null;
    if (!actorId && request.auth?.email) {
      const actor = await prisma.user.findUnique({
        where: { email: request.auth.email },
        select: { id: true },
      });
      actorId = actor?.id ?? null;
    }
    const { staffId } = request.params as { staffId: string };
    const input = parse(RecordConsentInput, request.body);
    const db = forTenant(tenantId);
    const staff = await db.staffProfile.findFirst({
      where: { id: staffId },
      select: { id: true, locationId: true },
    });
    if (!staff) throw notFound('Staff member');

    const record = await db.voiceConsentRecord.create({
      data: {
        tenantId,
        staffProfileId: staffId,
        action: input.action,
        source: input.source,
        notes: input.notes,
        recordedByUserId: actorId ?? undefined,
      },
    });

    // Revocation takes effect immediately: retire every cloned voice for this
    // person. A catalog voice assigned to their persona is nobody's real voice
    // and stays.
    if (input.action === 'revoked') {
      await db.staffVoiceProfile.updateMany({
        where: { staffProfileId: staffId, source: 'clone' },
        data: { status: 'revoked', enabledForRotation: false },
      });
    }

    await writeAudit({
      tenantId,
      locationId: staff.locationId,
      action: input.action === 'granted' ? 'voice.consent.granted' : 'voice.consent.revoked',
      targetType: 'staff',
      targetId: staffId,
      actorId,
      metadata: { source: input.source },
    });
    return reply.status(201).send(record);
  });

  // ---- Voice profiles (creation requires active consent) ----

  app.post('/v1/staff/:staffId/voice', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { staffId } = request.params as { staffId: string };
    const input = parse(CreateVoiceProfileInput, request.body);
    const db = forTenant(tenantId);
    const staff = await db.staffProfile.findFirst({
      where: { id: staffId },
      select: { id: true, locationId: true, name: true },
    });
    if (!staff) throw notFound('Staff member');

    // The gate: the LATEST consent record must be a grant (rule #6 — enforced
    // in code, not policy). No record at all also blocks.
    const latest = await db.voiceConsentRecord.findFirst({
      where: { staffProfileId: staffId },
      orderBy: { createdAt: 'desc' },
      select: { action: true },
    });
    if (latest?.action !== 'granted') {
      throw new HttpError(422, 'Voice cloning requires recorded consent', 'consent_required');
    }
    // Staff voices are a Pro feature (pricing §10). Consent comes first: a
    // location without consent is refused whatever it pays.
    await requireEntitlement(staff.locationId, 'staff_voices');

    // Sample audio upload/storage is a later step (Cloud Storage in prod) —
    // the dev cloner needs none. Real vendors slot in behind the interface.
    const { voiceId } = await cloner.createVoice({ sampleAudio: [], label: input.label });
    const profile = await db.staffVoiceProfile.create({
      data: {
        tenantId,
        staffProfileId: staffId,
        label: input.label,
        status: 'ready',
        source: 'clone',
        provider: cloner.name,
        providerVoiceId: voiceId,
      },
    });
    await writeAudit({
      tenantId,
      locationId: staff.locationId,
      action: 'voice.profile.created',
      targetType: 'staff_voice',
      targetId: profile.id,
      metadata: { staffId, provider: cloner.name },
    });
    return reply.status(201).send(profile);
  });

  app.patch('/v1/voice-profiles/:voiceId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { voiceId } = request.params as { voiceId: string };
    const input = parse(UpdateVoiceProfileInput, request.body);
    const db = forTenant(tenantId);
    const existing = await db.staffVoiceProfile.findFirst({
      where: { id: voiceId },
      select: { id: true, status: true },
    });
    if (!existing) throw notFound('Voice profile');
    if (input.enabledForRotation && existing.status !== 'ready') {
      throw new HttpError(422, 'Only a ready voice can join the rotation', 'voice_not_ready');
    }
    return db.staffVoiceProfile.update({ where: { id: voiceId }, data: input });
  });

  app.delete('/v1/voice-profiles/:voiceId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { voiceId } = request.params as { voiceId: string };
    const db = forTenant(tenantId);
    const existing = await db.staffVoiceProfile.findFirst({
      where: { id: voiceId },
      select: { id: true, staffProfileId: true },
    });
    if (!existing) throw notFound('Voice profile');
    await db.staffVoiceProfile.delete({ where: { id: voiceId } });
    await writeAudit({
      tenantId,
      action: 'voice.profile.deleted',
      targetType: 'staff_voice',
      targetId: voiceId,
      metadata: { staffId: existing.staffProfileId },
    });
    return reply.status(204).send();
  });

  // ---- Voice plane: personas a caller may ask for by name (node-authed) ----
  // Active staff at the call's location with a ready voice — the names the
  // engine tells the model about. Empty unless the location turned this on.
  async function personasFor(locationId: string) {
    const settings = await prisma.locationAiSettings.findUnique({
      where: { locationId },
      select: { personaSwitchEnabled: true },
    });
    if (!settings?.personaSwitchEnabled) return { enabled: false, personas: [] as Array<{ name: string; voiceId: string }> };
    const staff = await prisma.staffProfile.findMany({
      where: { locationId, active: true, voiceProfiles: { some: { status: 'ready', providerVoiceId: { not: null } } } },
      orderBy: { createdAt: 'asc' },
      select: { name: true, voiceProfiles: { where: { status: 'ready' }, orderBy: { createdAt: 'asc' }, take: 1, select: { providerVoiceId: true } } },
    });
    return {
      enabled: true,
      personas: staff.map((s) => ({ name: s.name, voiceId: s.voiceProfiles[0]!.providerVoiceId! })),
    };
  }

  app.get('/v1/calls/:callId/tools/personas', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { locationId: true } });
    if (!call) throw notFound('Call');
    const { enabled, personas } = await personasFor(call.locationId);
    return { enabled, personas: personas.map((p) => ({ name: p.name })) };
  });

  // Hand the call to the persona the caller asked for. The voice is re-checked
  // here (ready, active) so a revoked voice can never be switched to.
  app.post('/v1/calls/:callId/tools/persona', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const input = parse(SwitchPersonaInput, request.body);
    const call = await prisma.call.findUnique({ where: { id: callId }, select: { locationId: true } });
    if (!call) throw notFound('Call');
    const { enabled, personas } = await personasFor(call.locationId);
    if (!enabled) throw new HttpError(409, 'This location does not hand calls between personas', 'persona_switch_disabled');
    const wanted = input.name.trim().toLowerCase();
    const persona =
      personas.find((p) => p.name.toLowerCase() === wanted) ??
      personas.find((p) => p.name.toLowerCase().split(/\s+/)[0] === wanted.split(/\s+/)[0]);
    if (!persona) throw notFound('Persona');
    await prisma.callEvent.create({
      data: { callId, eventType: 'call.persona_switched', payload: { staffName: persona.name } },
    });
    return { voiceId: persona.voiceId, staffName: persona.name };
  });

  // ---- Voice plane: which voice answers this call? (node-authed) ----
  // Resolution: fixed → that profile if still ready; rotate → cycle the
  // rotation-enabled ready profiles by day; otherwise the built-in voice the
  // owner chose (null = the provider default) answering under the name they
  // gave it. A revoked voice can never be returned — status is checked at
  // call time.
  app.get('/v1/calls/:callId/tools/voice', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { locationId: true },
    });
    if (!call) throw notFound('Call');
    const settings = await prisma.locationAiSettings.findUnique({
      where: { locationId: call.locationId },
      select: {
        voiceMode: true,
        fixedVoiceProfileId: true,
        voiceRotation: true,
        voicePersona: true,
        defaultVoiceId: true,
        assistantName: true,
      },
    });
    const fallback = {
      voiceId: settings?.defaultVoiceId ?? null,
      staffName: settings?.assistantName ?? null,
      persona: settings?.voicePersona ?? null,
    };
    if (!settings || settings.voiceMode === 'default') return fallback;

    if (settings.voiceMode === 'fixed' && settings.fixedVoiceProfileId) {
      const v = await prisma.staffVoiceProfile.findFirst({
        where: { id: settings.fixedVoiceProfileId, status: 'ready' },
        include: { staff: { select: { name: true, active: true } } },
      });
      if (v?.providerVoiceId && v.staff.active) {
        return { voiceId: v.providerVoiceId, staffName: v.staff.name, persona: null };
      }
      return fallback;
    }

    if (settings.voiceMode === 'rotate') {
      const pool = await prisma.staffVoiceProfile.findMany({
        where: {
          status: 'ready',
          enabledForRotation: true,
          staff: { locationId: call.locationId, active: true },
        },
        orderBy: { createdAt: 'asc' },
        include: { staff: { select: { name: true } } },
      });
      if (pool.length) {
        // Daily: everyone who calls today hears the same person. Per call: a
        // round robin stepped by this location's call sequence — the call
        // being answered is already counted, so the first call is index 0.
        const index =
          settings.voiceRotation === 'per_call'
            ? Math.max(0, (await prisma.call.count({ where: { locationId: call.locationId } })) - 1) % pool.length
            : Math.floor(Date.now() / 86_400_000) % pool.length;
        const v = pool[index];
        if (v?.providerVoiceId) {
          return { voiceId: v.providerVoiceId, staffName: v.staff.name, persona: null };
        }
      }
    }
    return fallback;
  });
}

/** Verify the location belongs to the active tenant. */
async function assertLocation(tenantId: string, locationId: string) {
  const db = forTenant(tenantId);
  const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!location) throw notFound('Location');
}
