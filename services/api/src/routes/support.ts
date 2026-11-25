import type { FastifyInstance } from 'fastify';
import { forTenant, prisma } from '@brayz/db';
import { CreateSupportRequestInput } from '@brayz/shared';
import { conflict, notFound, parse } from '../lib/http.js';
import { requireTenant, requireTenantRole } from '../plugins/auth.js';

/**
 * The customer's side of support: a restaurant asking Brayz for help, and
 * reading what Brayz said back.
 *
 * Tenant-scoped like everything else (rule #1) — a restaurant sees only its
 * own. Brayz staff read the same rows across tenants in `routes/admin.ts`,
 * which is the only place allowed to.
 */
export async function supportRoutes(app: FastifyInstance): Promise<void> {
  /** POST /v1/support-requests — ask for help. Any member may; it is a cry for help, not a config change. */
  app.post('/v1/support-requests', async (request, reply) => {
    const tenantId = requireTenant(request);
    const input = parse(CreateSupportRequestInput, request.body);
    // Who asked. `userId` is set in firebase mode; dev-mode header auth carries
    // only an email, and a support request with nobody's name on it is one
    // staff cannot reply to — so fall back to looking the user up.
    const userId =
      request.auth?.userId ??
      (request.auth?.email
        ? ((await prisma.user.findUnique({
            where: { email: request.auth.email },
            select: { id: true },
          })) ?? null)?.id ?? null
        : null);

    // A location, if named, must belong to this tenant — otherwise a support
    // request becomes a way to confirm another restaurant's location id exists.
    if (input.locationId) {
      const db = forTenant(tenantId);
      const location = await db.location.findUnique({
        where: { id: input.locationId },
        select: { id: true },
      });
      if (!location) throw notFound('Location');
    }

    const created = await prisma.supportRequest.create({
      data: {
        tenantId,
        locationId: input.locationId ?? null,
        createdById: userId,
        subject: input.subject,
        body: input.body,
        severity: input.severity,
      },
      select: {
        id: true,
        subject: true,
        body: true,
        severity: true,
        status: true,
        createdAt: true,
        locationId: true,
      },
    });
    return reply.status(201).send(created);
  });

  /** GET /v1/support-requests — this restaurant's own requests and any replies. */
  app.get('/v1/support-requests', async (request) => {
    const tenantId = requireTenant(request);
    const db = forTenant(tenantId);
    const requests = await db.supportRequest.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        subject: true,
        body: true,
        severity: true,
        status: true,
        staffReply: true,
        repliedAt: true,
        resolvedAt: true,
        createdAt: true,
        locationId: true,
        location: { select: { name: true } },
        createdBy: { select: { email: true, displayName: true } },
      },
    });
    return {
      requests: requests.map((r) => ({
        id: r.id,
        subject: r.subject,
        body: r.body,
        severity: r.severity,
        status: r.status,
        staffReply: r.staffReply,
        repliedAt: r.repliedAt,
        resolvedAt: r.resolvedAt,
        createdAt: r.createdAt,
        locationId: r.locationId,
        locationName: r.location?.name ?? null,
        fromEmail: r.createdBy?.email ?? null,
        fromName: r.createdBy?.displayName ?? null,
      })),
    };
  });

  /**
   * DELETE /v1/support-requests/:id — withdraw one.
   *
   * Manager+, and only while it is still open: once Brayz has picked it up or
   * answered, the thread is a shared record and deleting it would erase the
   * reply from under the person who asked.
   */
  app.delete('/v1/support-requests/:id', async (request, reply) => {
    const tenantId = requireTenant(request);
    await requireTenantRole(request, tenantId, 'manager');
    const { id } = request.params as { id: string };
    const db = forTenant(tenantId);
    const existing = await db.supportRequest.findUnique({
      where: { id },
      select: { id: true, status: true },
    });
    if (!existing) throw notFound('Support request');
    if (existing.status !== 'open') {
      throw conflict('Brayz has already picked this up — reply to it instead');
    }
    await db.supportRequest.delete({ where: { id } });
    return reply.status(204).send();
  });
}
