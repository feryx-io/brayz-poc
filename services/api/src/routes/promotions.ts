import type { FastifyInstance } from 'fastify';
import { PromotionInput, PromotionPatch } from '@brayz/shared';
import { Prisma, forTenant, prisma } from '@brayz/db';
import { HttpError, conflict, notFound, parse } from '../lib/http.js';
import { requireNode } from '../auth/node.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';
import { locationGuestMemoryMode } from '../lib/guests.js';
import { describeOffer, eligiblePromotions, type GuestFacts } from '../lib/promotions.js';

/**
 * Promotions (plan §12.1). The dashboard manages offers; the voice plane asks
 * which ones a caller qualifies for.
 *
 * The split matters: eligibility and money are decided here (rule #5), so the
 * in-call tool returns offers already worded ("$5 off") rather than the raw
 * rule for the model to do arithmetic on.
 */
export async function promotionRoutes(app: FastifyInstance): Promise<void> {
  async function assertLocation(tenantId: string, locationId: string) {
    const db = forTenant(tenantId);
    const loc = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
    if (!loc) throw notFound('Location');
  }

  // ---- Dashboard ----

  app.get('/v1/locations/:locationId/promotions', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);

    const promos = await prisma.promotion.findMany({
      where: { locationId },
      orderBy: [{ active: 'desc' }, { createdAt: 'desc' }],
      include: { _count: { select: { redemptions: true } } },
    });
    return promos.map(({ _count, ...p }) => ({
      ...p,
      offer: describeOffer(p),
      redemptionCount: _count.redemptions,
    }));
  });

  app.post('/v1/locations/:locationId/promotions', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(tenantId, locationId);
    const input = parse(PromotionInput, request.body);

    try {
      const created = await prisma.promotion.create({
        // Prisma parses ISO strings for DateTime, so the input passes straight through.
        data: { tenantId, locationId, ...input },
      });
      return reply.status(201).send({ ...created, offer: describeOffer(created) });
    } catch (err) {
      // A code is what a caller says out loud; two promotions answering to the
      // same word at one location has no sensible resolution.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('A promotion with that code already exists at this location');
      }
      throw err;
    }
  });

  app.patch('/v1/promotions/:promotionId', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { promotionId } = request.params as { promotionId: string };
    const db = forTenant(tenantId);
    const existing = await db.promotion.findFirst({ where: { id: promotionId } });
    if (!existing) throw notFound('Promotion');
    const patch = parse(PromotionPatch, request.body);

    // Validate the promotion as it will be, not just the fields that moved —
    // switching kind without sending a value would otherwise leave it worthless.
    const merged = { ...existing, ...patch };
    if (merged.kind === 'percent_off' && !merged.percentOff) {
      throw new HttpError(422, 'A percent-off promotion needs a percentage', 'invalid_promotion');
    }
    if (merged.kind === 'amount_off' && !merged.amountOffCents) {
      throw new HttpError(422, 'An amount-off promotion needs an amount', 'invalid_promotion');
    }

    try {
      const updated = await prisma.promotion.update({
        where: { id: promotionId },
        data: patch,
      });
      return { ...updated, offer: describeOffer(updated) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict('A promotion with that code already exists at this location');
      }
      throw err;
    }
  });

  app.delete('/v1/promotions/:promotionId', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { promotionId } = request.params as { promotionId: string };
    const db = forTenant(tenantId);
    const existing = await db.promotion.findFirst({
      where: { id: promotionId },
      select: { id: true, _count: { select: { redemptions: true } } },
    });
    if (!existing) throw notFound('Promotion');

    // Deleting would take its redemptions with it (cascade) and silently rewrite
    // what past orders were discounted by. Retire it instead.
    if (existing._count.redemptions > 0) {
      throw conflict('This promotion has been redeemed — switch it off instead of deleting it');
    }
    await prisma.promotion.delete({ where: { id: promotionId } });
    return reply.status(204).send();
  });

  // ---- Voice plane (node-authed): what can we offer this caller? ----

  app.get('/v1/calls/:callId/tools/promotions', async (request) => {
    requireNode(request);
    const { callId } = request.params as { callId: string };
    const call = await prisma.call.findUnique({
      where: { id: callId },
      select: { locationId: true, guestId: true },
    });
    if (!call) throw notFound('Call');

    const facts = await guestFactsForCall(call.locationId, call.guestId);
    return { promotions: await eligiblePromotions(call.locationId, facts) };
  });
}

/**
 * The caller's history, as the audience rules need it. A guest who opted out of
 * memory — or a location with memory off — is treated as a stranger rather than
 * refused: they still get the offers open to everyone, and none that would
 * reveal Brayz remembers them (rule #6).
 */
export async function guestFactsForCall(
  locationId: string,
  guestId: string | null | undefined,
): Promise<GuestFacts> {
  const anonymous: GuestFacts = {
    guestId: null,
    lifetimeSpendCents: 0,
    birthdayMonth: null,
    lastOrderAt: null,
  };
  if (!guestId) return anonymous;

  const mode = await locationGuestMemoryMode(locationId);
  if (mode === 'off') return anonymous;

  const guest = await prisma.guest.findUnique({
    where: { id: guestId },
    select: { memoryEnabled: true, birthdayMonth: true },
  });
  if (!guest?.memoryEnabled) return anonymous;

  const [account, lastOrder] = await Promise.all([
    prisma.loyaltyAccount.findUnique({
      where: { guestId },
      select: { lifetimeSpendCents: true },
    }),
    prisma.order.findFirst({
      where: { guestId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ]);
  return {
    guestId,
    lifetimeSpendCents: account?.lifetimeSpendCents ?? 0,
    birthdayMonth: guest.birthdayMonth ?? null,
    lastOrderAt: lastOrder?.createdAt ?? null,
  };
}
