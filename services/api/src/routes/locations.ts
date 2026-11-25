import type { FastifyInstance } from 'fastify';
import {
  CreateLocationInput,
  DuplicateCheckInput,
  SetHoursInput,
  UpdateLocationInput,
  parseZipList,
} from '@brayz/shared';
import { forTenant, writeAudit } from '@brayz/db';
import { HttpError, forbidden, notFound, parse } from '../lib/http.js';
import { findDuplicateLocations } from '../lib/duplicates.js';
import { locationOrigin } from '../lib/delivery.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import type { GeocodingProvider } from '../lib/geocoding.js';

export interface LocationRouteOptions {
  /** Finds the restaurant's own position when a delivery radius needs it. */
  geocoder?: GeocodingProvider | null;
}

export async function locationRoutes(app: FastifyInstance, opts: LocationRouteOptions = {}): Promise<void> {
  const geocoder = opts.geocoder ?? null;
  // List locations for the active tenant.
  app.get('/v1/locations', async (request) => {
    const tenantId = requireTenant(request);
    const db = forTenant(tenantId);
    return db.location.findMany({ orderBy: { createdAt: 'asc' } });
  });

  /**
   * Refuse a save that would claim another account's phone number; hold one
   * that looks like a duplicate until the owner has seen why and said to go
   * on — and write down that they did.
   */
  async function guardDuplicates(
    request: { auth?: { userId?: string } },
    tenantId: string,
    check: DuplicateCheckInput,
    acknowledged: boolean,
    audit: { locationId?: string; action: string },
  ): Promise<void> {
    const findings = await findDuplicateLocations(check, { tenantId });
    if (findings.length === 0) return;
    const blocking = findings.find((f) => f.blocking);
    if (blocking) {
      throw new HttpError(409, blocking.message, 'phone_claimed', { findings });
    }
    if (!acknowledged) {
      throw new HttpError(409, findings[0]!.message, 'possible_duplicate', { findings });
    }
    await writeAudit({
      tenantId,
      locationId: audit.locationId ?? null,
      actorId: request.auth?.userId ?? null,
      action: audit.action,
      targetType: 'location',
      targetId: audit.locationId ?? null,
      // What the owner typed and what was flagged — never the other account.
      metadata: { name: check.name, city: check.city ?? null, postalCode: check.postalCode ?? null, findings: findings.map((f) => f.kind) },
    });
  }

  // Ask before saving: what would the sign-up checks say about this restaurant?
  app.post('/v1/locations/duplicate-check', async (request) => {
    const tenantId = requireTenant(request);
    const input = parse(DuplicateCheckInput, request.body);
    return { findings: await findDuplicateLocations(input, { tenantId }) };
  });

  app.post('/v1/locations', async (request, reply) => {
    const tenantId = requireTenant(request);
    const input = parse(CreateLocationInput, request.body);
    if (input.tenantId !== tenantId) throw forbidden('tenantId does not match active tenant');
    await requireTenantRole(request, tenantId, 'manager');

    const { tenantId: _omit, acknowledgeDuplicates, ...rest } = input;
    await guardDuplicates(
      request,
      tenantId,
      { name: rest.name, addressLine1: rest.addressLine1, city: rest.city, postalCode: rest.postalCode, mainPhone: rest.mainPhone },
      acknowledgeDuplicates === true,
      { action: 'location.duplicate_acknowledged' },
    );
    const db = forTenant(tenantId);
    const location = await db.location.create({ data: { ...rest, tenantId } });
    return reply.status(201).send(location);
  });

  app.get('/v1/locations/:locationId', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    const location = await db.location.findFirst({
      where: { id: locationId },
      include: { hours: { orderBy: { dayOfWeek: 'asc' } } },
    });
    if (!location) throw notFound('Location');
    return location;
  });

  app.patch('/v1/locations/:locationId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const input = parse(UpdateLocationInput, request.body);

    const db = forTenant(tenantId);
    const existing = await db.location.findFirst({ where: { id: locationId } });
    if (!existing) throw notFound('Location');
    const { acknowledgeDuplicates, ...data } = input;
    // Only an edit to what identifies the restaurant is re-checked; a new
    // greeting or notification number is not a new restaurant.
    const identityChanged = (['name', 'addressLine1', 'city', 'postalCode', 'mainPhone'] as const).some(
      (k) => data[k] !== undefined && data[k] !== existing[k],
    );
    if (identityChanged) {
      const merged = { ...existing, ...data };
      await guardDuplicates(
        request,
        tenantId,
        {
          name: merged.name,
          addressLine1: merged.addressLine1 ?? undefined,
          city: merged.city ?? undefined,
          postalCode: merged.postalCode ?? undefined,
          mainPhone: merged.mainPhone ?? undefined,
          excludeLocationId: locationId,
        },
        acknowledgeDuplicates === true,
        { locationId, action: 'location.duplicate_acknowledged' },
      );
    }
    // A moved restaurant is somewhere else: forget where it was, so the radius
    // is measured from where it is now.
    const addressChanged = (['addressLine1', 'city', 'region', 'postalCode'] as const).some(
      (k) => data[k] !== undefined && data[k] !== existing[k],
    );
    const updated = await db.location.update({
      where: { id: locationId },
      data: {
        ...data,
        // "12866-1234" and " 12866" are the ZIP the owner meant.
        ...(data.deliveryZipCodes ? { deliveryZipCodes: parseZipList(data.deliveryZipCodes.join(' ')) } : {}),
        ...(addressChanged ? { latitude: null, longitude: null } : {}),
      },
    });
    // Place the restaurant while the owner is saving rather than on the first
    // delivery call, where a caller would wait on it. Best-effort: a lookup that
    // fails is tried again when a delivery needs it.
    if (geocoder && (updated.deliveryRadiusMiles ?? 0) > 0 && updated.latitude == null) {
      const origin = await locationOrigin(updated, geocoder).catch(() => null);
      if (origin) return { ...updated, latitude: origin.lat, longitude: origin.lng };
    }
    return updated;
  });

  // Delete a location (cascades its menu, hours, calls, numbers, etc.). Releasing
  // any purchased Twilio numbers is a separate concern — this only drops the rows.
  app.delete('/v1/locations/:locationId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    const existing = await db.location.findFirst({ where: { id: locationId } });
    if (!existing) throw notFound('Location');
    await db.location.delete({ where: { id: locationId } });
    return reply.status(204).send();
  });

  // Replace the weekly hours for a location.
  app.put('/v1/locations/:locationId/hours', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    const { intervals } = parse(SetHoursInput, request.body);

    const db = forTenant(tenantId);
    const location = await db.location.findFirst({ where: { id: locationId } });
    if (!location) throw notFound('Location');

    // Hours are reached through the tenant-scoped location, so use the base
    // client transaction here; ownership is already verified above.
    await forTenant(tenantId).location.update({
      where: { id: locationId },
      data: {
        hours: { deleteMany: {}, create: intervals.map((i) => ({ ...i })) },
      },
    });
    return { ok: true, count: intervals.length };
  });
}
