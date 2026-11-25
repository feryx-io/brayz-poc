import { prisma } from '@brayz/db';
import {
  ManualTicketProvider,
  PosCapabilityError,
  SquarePosProvider,
  isRetryable,
  type PosConnection,
  type PosOrder,
  type PosOrderStatus,
  type PosProvider,
} from '@brayz/pos';
import type { PosProviderName } from '@brayz/shared';

/**
 * POS plumbing for the order routes (CLAUDE.md rule #2 — nothing here knows
 * what Square is beyond picking its adapter).
 *
 * The push is deliberately *after* the order commits and never inside its
 * transaction: Brayz is the system of record (rule #3), so a POS that is down
 * must cost the till a ticket, not the guest their order. Every attempt is
 * recorded on `PosOrderSync`, keyed by order, so a failure is visible on the
 * Orders screen and retryable instead of silently lost.
 */

/** Overridable in tests; production resolves the real adapters. */
export type PosProviderFactory = (provider: PosProviderName) => PosProvider | null;

export const defaultPosProviderFactory: PosProviderFactory = (provider) => {
  switch (provider) {
    case 'manual':
      return new ManualTicketProvider();
    case 'square':
      return new SquarePosProvider();
    // Toast/Clover are on the partner path (plan §12.4) — configuring one is
    // accepted, but there is no adapter to push to yet.
    default:
      return null;
  }
};

export interface ResolvedPos {
  provider: PosProvider;
  connection: PosConnection;
}

/** The location's POS, or null when none is configured or it is switched off. */
export async function resolvePosForLocation(
  locationId: string,
  factory: PosProviderFactory,
): Promise<ResolvedPos | null> {
  const integration = await prisma.posIntegration.findUnique({ where: { locationId } });
  if (!integration || !integration.enabled) return null;
  const provider = factory(integration.provider as PosProviderName);
  if (!provider) return null;
  return {
    provider,
    connection: {
      locationId,
      externalLocationId: integration.externalLocationId ?? undefined,
      accessToken: integration.accessToken ?? undefined,
      environment: integration.environment === 'production' ? 'production' : 'sandbox',
    },
  };
}

export interface PushOrderArgs {
  tenantId: string;
  locationId: string;
  order: PosOrder;
}

export interface PushOutcome {
  status: 'synced' | 'failed' | 'unsupported' | 'skipped';
  externalOrderId?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * Push a committed order to the location's POS, recording the attempt.
 *
 * Idempotent on the order (rule #7): the sync row is unique per order, and an
 * order already synced returns its existing ticket rather than raising a second
 * one. Never throws — the caller is on the order-confirmation path.
 */
export async function pushOrderToPos(
  log: { warn: (obj: unknown, msg?: string) => void },
  factory: PosProviderFactory,
  args: PushOrderArgs,
): Promise<PushOutcome> {
  const { tenantId, locationId, order } = args;
  const dedupeKey = `pos-order:${order.orderId}`;

  try {
    const existing = await prisma.posOrderSync.findUnique({ where: { orderId: order.orderId } });
    if (existing?.status === 'synced') {
      return { status: 'synced', externalOrderId: existing.externalOrderId ?? undefined };
    }

    const resolved = await resolvePosForLocation(locationId, factory);
    if (!resolved) return { status: 'skipped' };

    const { provider, connection } = resolved;
    // Claim the attempt before making it, so a crash mid-push leaves a visible
    // `pending` row rather than no evidence that a ticket was ever owed.
    await prisma.posOrderSync.upsert({
      where: { orderId: order.orderId },
      create: {
        tenantId,
        locationId,
        orderId: order.orderId,
        provider: provider.name,
        status: 'pending',
        attempts: 1,
        dedupeKey,
      },
      update: { provider: provider.name, status: 'pending', attempts: { increment: 1 } },
    });

    if (!provider.capabilities.createOrder) {
      await prisma.posOrderSync.update({
        where: { orderId: order.orderId },
        data: { status: 'unsupported', lastError: `${provider.name} cannot create orders` },
      });
      return { status: 'unsupported' };
    }

    try {
      const result = await provider.createOrder(connection, order);
      await prisma.posOrderSync.update({
        where: { orderId: order.orderId },
        data: {
          status: 'synced',
          externalOrderId: result.externalOrderId,
          lastError: null,
          syncedAt: new Date(),
        },
      });
      return { status: 'synced', externalOrderId: result.externalOrderId };
    } catch (err) {
      const retryable = isRetryable(err);
      const message = err instanceof Error ? err.message : String(err);
      await prisma.posOrderSync.update({
        where: { orderId: order.orderId },
        data: {
          status: err instanceof PosCapabilityError ? 'unsupported' : 'failed',
          lastError: message.slice(0, 1000),
        },
      });
      log.warn({ err, orderId: order.orderId, provider: provider.name }, 'POS order push failed');
      return { status: 'failed', error: message, retryable };
    }
  } catch (err) {
    // Bookkeeping itself failed. The order stands; say so and move on.
    log.warn({ err, orderId: order.orderId }, 'POS sync bookkeeping failed');
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Tell the POS an already-pushed ticket changed state. Best-effort: Brayz's own
 * status is authoritative, and a POS that misses the update is a stale till
 * display, not a wrong order.
 */
export async function pushOrderStatusToPos(
  log: { warn: (obj: unknown, msg?: string) => void },
  factory: PosProviderFactory,
  args: { locationId: string; orderId: string; status: PosOrderStatus },
): Promise<void> {
  try {
    const sync = await prisma.posOrderSync.findUnique({ where: { orderId: args.orderId } });
    // Nothing was ever pushed, so there is no ticket to update.
    if (!sync?.externalOrderId || sync.status !== 'synced') return;

    const resolved = await resolvePosForLocation(args.locationId, factory);
    if (!resolved || !resolved.provider.capabilities.updateOrderStatus) return;

    await resolved.provider.updateOrderStatus(
      resolved.connection,
      sync.externalOrderId,
      args.status,
    );
  } catch (err) {
    log.warn({ err, orderId: args.orderId }, 'POS status update failed');
  }
}
