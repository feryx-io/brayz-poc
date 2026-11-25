import type { FastifyInstance } from 'fastify';
import {
  CreatePhoneNumberInput,
  LocationAiSettingsInput,
  SetHolidayHoursInput,
} from '@brayz/shared';
import { loadConfig } from '@brayz/config';
import { forTenant, prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Holiday hours ----
  app.get('/v1/locations/:locationId/holiday-hours', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    return prisma.locationHolidayHours.findMany({
      where: { locationId },
      orderBy: { date: 'asc' },
    });
  });

  app.put('/v1/locations/:locationId/holiday-hours', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const { entries } = parse(SetHolidayHoursInput, request.body);

    await prisma.$transaction([
      prisma.locationHolidayHours.deleteMany({ where: { locationId } }),
      prisma.locationHolidayHours.createMany({
        data: entries.map((e) => ({
          locationId,
          date: new Date(e.date),
          closed: e.closed,
          opensAt: e.closed ? null : (e.opensAt ?? null),
          closesAt: e.closed ? null : (e.closesAt ?? null),
          label: e.label,
        })),
      }),
    ]);
    return { ok: true, count: entries.length };
  });

  // ---- AI / transfer settings ----
  app.get('/v1/locations/:locationId/ai-settings', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const settings = await prisma.locationAiSettings.findUnique({ where: { locationId } });
    // Return defaults if not yet configured.
    return withRetentionCeiling(
      settings ?? {
        locationId,
        transferEnabled: true,
        transferWhenOpen: true,
        offerMessageWhenClosed: true,
        maxCallSeconds: 600,
        voicePersona: null,
        guestMemoryMode: 'full',
        voiceMode: 'default',
        fixedVoiceProfileId: null,
        voiceRotation: 'daily',
        personaSwitchEnabled: false,
        defaultVoiceId: null,
        assistantName: null,
        orderAckMode: 'fast',
        closedBehavior: 'take_orders',
        scheduleOrdersEnabled: false,
        scheduleMaxDaysAhead: 1,
        recordingRetentionDays: null,
      },
    );
  });

  app.put('/v1/locations/:locationId/ai-settings', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const input = parse(LocationAiSettingsInput, request.body);
    // A location may keep recordings for less time than the platform does,
    // never more: the bucket's lifecycle rule deletes them at the ceiling
    // whatever is stored here, and a setting that promised otherwise would lie.
    const ceiling = loadConfig().RECORDING_MAX_RETENTION_DAYS;
    if (input.recordingRetentionDays != null && input.recordingRetentionDays > ceiling) {
      throw new HttpError(
        422,
        `Recordings are kept for at most ${ceiling} days`,
        'retention_above_ceiling',
      );
    }
    const saved = await prisma.locationAiSettings.upsert({
      where: { locationId },
      update: input,
      create: { locationId, ...input },
    });
    return withRetentionCeiling(saved);
  });

  // ---- Phone numbers ----
  app.get('/v1/locations/:locationId/phone-numbers', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const db = forTenant(tenantId);
    return db.phoneNumber.findMany({ where: { locationId }, orderBy: { createdAt: 'asc' } });
  });

  app.post('/v1/locations/:locationId/phone-numbers', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const input = parse(CreatePhoneNumberInput, request.body);
    const db = forTenant(tenantId);
    const phone = await db.phoneNumber.create({ data: { ...input, locationId, tenantId } });
    return reply.status(201).send(phone);
  });

  app.delete('/v1/phone-numbers/:phoneId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { phoneId } = request.params as { phoneId: string };
    const db = forTenant(tenantId);
    const existing = await db.phoneNumber.findFirst({ where: { id: phoneId } });
    if (!existing) throw notFound('Phone number');
    await db.phoneNumber.delete({ where: { id: phoneId } });
    return reply.status(204).send();
  });
}

/** Verify the location belongs to the active tenant. */
async function assertLocation(tenantId: string, locationId: string) {
  const db = forTenant(tenantId);
  const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!location) throw notFound('Location');
}

/**
 * The dashboard needs the ceiling to explain what "no policy" means and to
 * bound its input, and the ceiling is deployment config the row does not hold.
 */
function withRetentionCeiling<T extends object>(settings: T): T & { recordingRetentionMaxDays: number } {
  return { ...settings, recordingRetentionMaxDays: loadConfig().RECORDING_MAX_RETENTION_DAYS };
}
