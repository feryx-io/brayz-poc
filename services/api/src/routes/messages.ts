import type { FastifyInstance } from 'fastify';
import { CallMessageQuery, UpdateCallMessageInput } from '@brayz/shared';
import { forTenant, prisma } from '@brayz/db';
import { notFound, parse } from '../lib/http.js';
import { requireTenant } from '../plugins/auth.js';

/**
 * Messages callers left for the restaurant, for the Messages screen. Any
 * member of the tenant can read and work them — a message is an operational
 * thing, like an order ticket, and marking one done is not a policy change.
 * Tenant-scoped through forTenant on every query (rule #1).
 */
/**
 * Who is acting. Firebase auth puts the user id on the request; dev auth is
 * header-only and carries just the email, so look the user up by it there.
 */
async function actorId(request: { auth?: { userId?: string; email?: string } }): Promise<string | null> {
  if (request.auth?.userId) return request.auth.userId;
  if (!request.auth?.email) return null;
  const u = await prisma.user.findUnique({ where: { email: request.auth.email }, select: { id: true } });
  return u?.id ?? null;
}

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/locations/:locationId/messages', async (request) => {
    const tenantId = requireTenant(request);
    const { locationId } = request.params as { locationId: string };
    const { status, limit } = CallMessageQuery.parse(request.query ?? {});
    const db = forTenant(tenantId);
    const location = await db.location.findFirst({ where: { id: locationId }, select: { id: true } });
    if (!location) throw notFound('Location');
    const messages = await db.callMessage.findMany({
      where: { locationId, ...(status === 'all' ? {} : { status }) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const newCount = await db.callMessage.count({ where: { locationId, status: 'new' } });
    return { messages, newCount };
  });

  app.patch('/v1/messages/:messageId', async (request) => {
    const tenantId = requireTenant(request);
    const { messageId } = request.params as { messageId: string };
    const { status } = parse(UpdateCallMessageInput, request.body);
    const db = forTenant(tenantId);
    const existing = await db.callMessage.findFirst({ where: { id: messageId }, select: { id: true } });
    if (!existing) throw notFound('Message');
    return db.callMessage.update({
      where: { id: messageId },
      data:
        status === 'done'
          ? { status, doneAt: new Date(), doneById: await actorId(request) }
          : { status, doneAt: null, doneById: null },
    });
  });
}
