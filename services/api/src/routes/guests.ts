import type { FastifyInstance } from 'fastify';
import { UpdateGuestInput } from '@brayz/shared';
import { forTenant, Prisma, writeAudit } from '@brayz/db';
import { notFound, parse } from '../lib/http.js';
import { isVip, locationLoyaltySettings } from '../lib/loyalty.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

/**
 * Guest memory (dashboard side, user-authed + tenant-scoped). Restaurants view
 * and manage the profiles the bot builds: name, preference notes, order history,
 * the opt-out switch, and deletion (right-to-be-forgotten). Sensitive actions are
 * audited (CLAUDE.md rule #6).
 */
export async function guestRoutes(app: FastifyInstance): Promise<void> {
  // List guests for a location, with order counts and last-seen.
  app.get('/v1/locations/:locationId/guests', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    const guests = await db.guest.findMany({
      where: { locationId },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: {
        phoneNumbers: { select: { e164: true } },
        _count: { select: { orders: true } },
        orders: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
      },
    });
    return guests.map((g) => ({
      id: g.id,
      displayName: g.displayName,
      memoryEnabled: g.memoryEnabled,
      notes: g.notes,
      phones: g.phoneNumbers.map((p) => p.e164),
      orderCount: g._count.orders,
      lastOrderAt: g.orders[0]?.createdAt ?? null,
      createdAt: g.createdAt,
    }));
  });

  // One guest's full profile + order history. Reading a profile is audited access.
  app.get('/v1/guests/:guestId', async (request) => {
    const tenantId = requireTenant(request);
    const { guestId } = request.params as { guestId: string };
    const db = forTenant(tenantId);
    const guest = await db.guest.findFirst({
      where: { id: guestId },
      include: {
        phoneNumbers: { select: { e164: true } },
        orders: { orderBy: { createdAt: 'desc' }, take: 50, include: { items: true } },
        loyalty: {
          select: { pointsBalance: true, lifetimePoints: true, lifetimeSpendCents: true },
        },
      },
    });
    if (!guest) throw notFound('Guest');
    await writeAudit({
      tenantId,
      locationId: guest.locationId,
      action: 'guest_profile.accessed',
      targetType: 'guest',
      targetId: guest.id,
    });
    const loyaltySettings = guest.locationId ? await locationLoyaltySettings(guest.locationId) : null;
    return {
      ...guest,
      phones: guest.phoneNumbers.map((p) => p.e164),
      orders: guest.orders.map((o) => ({ ...o, code: orderCode(o.id) })),
      vip:
        !!loyaltySettings &&
        loyaltySettings.enabled &&
        isVip(guest.loyalty?.lifetimeSpendCents ?? 0, loyaltySettings),
    };
  });

  // Edit memory + consent. A memoryEnabled flip is a consent change (audited as such).
  app.patch('/v1/guests/:guestId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { guestId } = request.params as { guestId: string };
    const input = parse(UpdateGuestInput, request.body);
    const db = forTenant(tenantId);
    const existing = await db.guest.findFirst({
      where: { id: guestId },
      select: { id: true, memoryEnabled: true, locationId: true },
    });
    if (!existing) throw notFound('Guest');

    const { deliveryAddress, ...fields } = input;
    const updated = await db.guest.update({
      where: { id: guestId },
      data: {
        ...fields,
        // A Json column is cleared with DbNull, not null. Untouched stays untouched.
        ...(deliveryAddress === undefined
          ? {}
          : deliveryAddress === null
            ? { deliveryAddress: Prisma.DbNull, deliveryAddressUpdatedAt: null }
            : { deliveryAddress, deliveryAddressUpdatedAt: new Date() }),
      },
    });
    const consentChanged =
      input.memoryEnabled !== undefined && input.memoryEnabled !== existing.memoryEnabled;
    await writeAudit({
      tenantId,
      locationId: existing.locationId,
      action: consentChanged ? 'consent.changed' : 'guest.memory.updated',
      targetType: 'guest',
      targetId: guestId,
      metadata: consentChanged ? { memoryEnabled: input.memoryEnabled } : {},
    });
    return updated;
  });

  // Right-to-be-forgotten: delete the guest (phones cascade; calls/orders keep but
  // null their guestId).
  app.delete('/v1/guests/:guestId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { guestId } = request.params as { guestId: string };
    const db = forTenant(tenantId);
    const existing = await db.guest.findFirst({
      where: { id: guestId },
      select: { id: true, locationId: true },
    });
    if (!existing) throw notFound('Guest');
    await db.guest.delete({ where: { id: guestId } });
    await writeAudit({
      tenantId,
      locationId: existing.locationId,
      action: 'guest.deleted',
      targetType: 'guest',
      targetId: guestId,
    });
    return reply.status(204).send();
  });
}

function orderCode(id: string): string {
  return id.replace(/-/g, '').slice(-5).toUpperCase();
}
