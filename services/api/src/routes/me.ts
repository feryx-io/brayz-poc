import type { FastifyInstance } from 'fastify';
import { UpdateProfileInput } from '@brayz/shared';
import { prisma } from '@brayz/db';
import { notFound, parse, unauthorized } from '../lib/http.js';
import { platformActor } from '../auth/platform.js';

/** GET /v1/me — current auth context and tenant memberships. */
export async function meRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/me', async (request) => {
    const { email, tenantId } = request.auth;
    if (!email) {
      return { authenticated: false, tenantId: tenantId ?? null, memberships: [] };
    }
    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { include: { tenant: true } } },
    });
    // Brayz staff only: whether to offer the admin portal at all. Promoting a
    // configured bootstrap email happens here, on the first call every session
    // makes, so the first staff account exists before anyone opens /admin.
    const platform = await platformActor(request);
    return {
      authenticated: true,
      email,
      activeTenantId: tenantId ?? null,
      user: user
        ? { id: user.id, email: user.email, displayName: user.displayName }
        : null,
      platformRole: platform?.role ?? null,
      memberships:
        user?.memberships.map((m) => ({
          tenantId: m.tenantId,
          tenantName: m.tenant.name,
          role: m.role,
          locationId: m.locationId,
        })) ?? [],
    };
  });

  /** PATCH /v1/me — update the caller's own account profile (display name). */
  app.patch('/v1/me', async (request) => {
    const { userId, email } = request.auth;
    if (!userId && !email) throw unauthorized('Not authenticated');
    const input = parse(UpdateProfileInput, request.body);

    const where = userId ? { id: userId } : { email: email! };
    const existing = await prisma.user.findUnique({ where });
    if (!existing) throw notFound('User');

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { displayName: input.displayName },
    });
    return { id: user.id, email: user.email, displayName: user.displayName };
  });
}
