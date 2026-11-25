import type { FastifyInstance } from 'fastify';
import { UpsertPosIntegrationInput } from '@brayz/shared';
import { forTenant, prisma } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant } from '../plugins/auth.js';
import { defaultPosProviderFactory, pushOrderToPos, type PosProviderFactory } from '../lib/pos.js';
import { orderCode, toPosOrder } from '../lib/orderMapping.js';

export interface PosRouteOptions {
  /** Inject adapters (tests). Defaults to the real Square/manual factory. */
  posProviders?: PosProviderFactory;
}

/**
 * POS integration settings and manual re-push (Phase 8.4).
 *
 * The access token is write-only: it is accepted here and never returned by any
 * read, so a compromised dashboard session cannot exfiltrate a merchant's
 * Square credentials.
 *
 * Tenant scoping (rule #1) is enforced by `ownedLocation`, which resolves the
 * location through `forTenant` and 404s one the caller's tenant does not own.
 * An integration is keyed one-to-one on its location, so owning the location is
 * owning the integration — the same shape as the call-transcript read.
 */
export async function posRoutes(app: FastifyInstance, opts: PosRouteOptions = {}): Promise<void> {
  const factory = opts.posProviders ?? defaultPosProviderFactory;

  /** Resolve a location the caller's tenant actually owns. */
  async function ownedLocation(tenantId: string, locationId: string) {
    const db = forTenant(tenantId);
    const loc = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
    if (!loc) throw notFound('Location');
    return loc;
  }

  app.get('/v1/locations/:locationId/pos', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);

    const integration = await prisma.posIntegration.findUnique({ where: { locationId } });
    if (!integration) {
      return { provider: 'manual', enabled: false, configured: false };
    }
    const provider = factory(integration.provider as never);
    return {
      provider: integration.provider,
      enabled: integration.enabled,
      configured: true,
      environment: integration.environment,
      externalLocationId: integration.externalLocationId,
      // Never the token itself — only whether one is on file.
      hasAccessToken: !!integration.accessToken,
      capabilities: provider?.capabilities ?? null,
      updatedAt: integration.updatedAt,
    };
  });

  app.put('/v1/locations/:locationId/pos', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);
    const input = parse(UpsertPosIntegrationInput, request.body);

    const existing = await prisma.posIntegration.findUnique({ where: { locationId } });
    // Omitting either on an update keeps the stored value — the dashboard can
    // toggle `enabled` or fix one field without re-entering credentials.
    const accessToken = input.accessToken ?? existing?.accessToken ?? null;
    const externalLocationId = input.externalLocationId ?? existing?.externalLocationId ?? null;
    // `manual` needs neither; a real vendor is useless without both, and failing
    // here beats every order failing later against a half-configured POS.
    if (input.provider !== 'manual') {
      if (!accessToken) {
        throw new HttpError(
          422,
          `${input.provider} requires an access token`,
          'pos_not_configured',
        );
      }
      if (!externalLocationId) {
        throw new HttpError(
          422,
          `${input.provider} requires the vendor location id`,
          'pos_not_configured',
        );
      }
    }

    const saved = await prisma.posIntegration.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        provider: input.provider,
        enabled: input.enabled,
        externalLocationId,
        environment: input.environment,
        accessToken,
      },
      update: {
        provider: input.provider,
        enabled: input.enabled,
        externalLocationId,
        environment: input.environment,
        accessToken,
      },
    });
    return {
      provider: saved.provider,
      enabled: saved.enabled,
      configured: true,
      environment: saved.environment,
      externalLocationId: saved.externalLocationId,
      hasAccessToken: !!saved.accessToken,
    };
  });

  app.delete('/v1/locations/:locationId/pos', async (request, reply) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);
    await prisma.posIntegration.deleteMany({ where: { locationId } });
    return reply.status(204).send();
  });

  /** Read the POS catalog, for importing a menu Brayz doesn't have yet. */
  app.get('/v1/locations/:locationId/pos/menu', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    await ownedLocation(tenantId, locationId);

    const integration = await prisma.posIntegration.findUnique({ where: { locationId } });
    if (!integration || !integration.enabled) {
      throw new HttpError(422, 'No POS is connected for this location', 'pos_not_configured');
    }
    const provider = factory(integration.provider as never);
    if (!provider?.capabilities.getMenu) {
      throw new HttpError(
        422,
        `${integration.provider} cannot read a menu`,
        'pos_capability_unsupported',
      );
    }
    const items = await provider.getMenu({
      locationId,
      externalLocationId: integration.externalLocationId ?? undefined,
      accessToken: integration.accessToken ?? undefined,
      environment: integration.environment === 'production' ? 'production' : 'sandbox',
    });
    return { provider: integration.provider, items };
  });

  /**
   * Re-push an order whose ticket never reached the POS. Idempotent: an order
   * already synced returns its existing ticket rather than raising a second one.
   */
  app.post('/v1/orders/:orderId/pos/retry', async (request) => {
    const tenantId = requireTenant(request);
    const { orderId } = request.params as { orderId: string };
    const db = forTenant(tenantId);
    const order = await db.order.findFirst({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw notFound('Order');

    const outcome = await pushOrderToPos(app.log, factory, {
      tenantId,
      locationId: order.locationId,
      order: toPosOrder(order, orderCode(order.id)),
    });
    if (outcome.status === 'skipped') {
      throw new HttpError(422, 'No POS is connected for this location', 'pos_not_configured');
    }
    return outcome;
  });
}
