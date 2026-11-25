import type { FastifyInstance } from 'fastify';
import { CreateTransferTargetInput, UpdateTransferTargetInput } from '@brayz/shared';
import { forTenant, prisma, type TenantScopedClient } from '@brayz/db';
import { HttpError, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

/**
 * Per-location transfer destinations (dashboard, user-authed, tenant-scoped).
 * The voice plane reads these via the node-authed tool endpoint in tools.ts.
 * LocationTransferTarget has no tenantId column, so we gate every write through
 * its location, which IS tenant-scoped (CLAUDE.md rule #1).
 */
export async function transferTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/locations/:locationId/transfer-targets', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const db = forTenant(tenantId);
    await assertLocation(db, locationId);
    return prisma.locationTransferTarget.findMany({ where: { locationId }, orderBy: { sortOrder: 'asc' } });
  });

  app.post('/v1/locations/:locationId/transfer-targets', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { locationId } = request.params as { locationId: string };
    await assertLocation(forTenant(tenantId), locationId);
    const input = parse(CreateTransferTargetInput, request.body);
    try {
      const created = await prisma.locationTransferTarget.create({ data: { locationId, ...input } });
      return reply.status(201).send(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, `Transfer key "${input.key}" already exists`, 'duplicate_key');
      throw err;
    }
  });

  app.patch('/v1/transfer-targets/:id', async (request) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { id } = request.params as { id: string };
    await assertTargetInTenant(tenantId, id);
    const input = parse(UpdateTransferTargetInput, request.body);
    return prisma.locationTransferTarget.update({ where: { id }, data: input });
  });

  app.delete('/v1/transfer-targets/:id', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { id } = request.params as { id: string };
    await assertTargetInTenant(tenantId, id);
    await prisma.locationTransferTarget.delete({ where: { id } });
    return reply.status(204).send();
  });
}

async function assertLocation(db: TenantScopedClient, locationId: string): Promise<void> {
  const loc = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
  if (!loc) throw notFound('Location');
}

async function assertTargetInTenant(tenantId: string, id: string): Promise<void> {
  const target = await prisma.locationTransferTarget.findUnique({
    where: { id },
    select: { location: { select: { tenantId: true } } },
  });
  if (!target || target.location.tenantId !== tenantId) throw notFound('Transfer target');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err != null && (err as { code?: string }).code === 'P2002';
}
