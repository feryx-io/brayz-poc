import type { FastifyRequest } from 'fastify';
import { prisma } from '@brayz/db';
import { platformRoleAtLeast, type PlatformRole } from '@brayz/shared';
import { loadConfig } from '@brayz/config';
import { forbidden, unauthorized } from '../lib/http.js';

/**
 * Who may open the Brayz staff admin portal.
 *
 * This is the gate on the one part of the API that reads across tenants
 * (rule #1's second deliberate exception, after `lib/duplicates.ts`). It answers
 * from `User.platformRole` in the database and from nothing the caller sends —
 * no header, no tenant membership, no role a customer can grant themselves.
 */

/** Emails granted `admin` on first sign-in, so the first staff account can exist. */
function bootstrapEmails(): Set<string> {
  const raw = loadConfig().PLATFORM_ADMIN_EMAILS ?? '';
  return new Set(
    raw
      .split(',')
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface PlatformActor {
  userId: string;
  email: string;
  role: PlatformRole;
}

/**
 * Resolve the caller's platform role, promoting a bootstrap email the first
 * time it is seen. Returns null for everyone else — which is almost everyone.
 */
export async function platformActor(request: FastifyRequest): Promise<PlatformActor | null> {
  const { userId, email } = request.auth ?? {};
  if (!userId && !email) return null;

  const user = await prisma.user.findUnique({
    where: userId ? { id: userId } : { email: email! },
    select: { id: true, email: true, platformRole: true },
  });
  if (!user) return null;

  let role = user.platformRole;
  if (!role && bootstrapEmails().has(user.email.toLowerCase())) {
    // First sign-in of a configured founder/staff account.
    const promoted = await prisma.user.update({
      where: { id: user.id },
      data: { platformRole: 'admin' },
      select: { platformRole: true },
    });
    role = promoted.platformRole;
  }
  if (role !== 'support' && role !== 'admin') return null;
  return { userId: user.id, email: user.email, role };
}

/**
 * Require Brayz staff access. `support` may read the portal; `admin` may also
 * change support requests and grant staff access to others.
 *
 * Not-staff is 404-shaped on purpose at the route level: the admin portal's
 * existence is not something a restaurant owner needs confirmed by probing.
 * Here it is a plain 403 for a caller who is authenticated but not staff.
 */
export async function requirePlatformStaff(
  request: FastifyRequest,
  min: PlatformRole = 'support',
): Promise<PlatformActor> {
  const actor = await platformActor(request);
  if (!actor) {
    if (!request.auth?.userId && !request.auth?.email) throw unauthorized('Not authenticated');
    throw forbidden('Brayz staff only');
  }
  if (!platformRoleAtLeast(actor.role, min)) {
    throw forbidden(`Requires platform role >= ${min}`);
  }
  return actor;
}
