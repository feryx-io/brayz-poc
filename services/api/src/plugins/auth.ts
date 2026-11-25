import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Role } from '@brayz/shared';
import { roleAtLeast } from '@brayz/shared';
import { loadConfig } from '@brayz/config';
import { prisma } from '@brayz/db';
import { forbidden, unauthorized } from '../lib/http.js';
import { FirebaseAuthVerifier, type AuthVerifier } from '../auth/firebase.js';

/**
 * Auth context resolved per request.
 *
 * Two modes (AUTH_MODE):
 *  - `dev`: trust `x-brayz-user-email` / `x-brayz-tenant-id` headers (local/tests).
 *  - `firebase`: verify a Bearer ID token, provision the user, and accept a tenant
 *    header only if the user is a member of that tenant.
 *
 * Routes only depend on `request.auth`, so they don't change between modes.
 */
export interface AuthContext {
  userId?: string;
  email?: string;
  tenantId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
}

export function registerAuth(app: FastifyInstance): void {
  const cfg = loadConfig();
  app.decorateRequest('auth', null as unknown as AuthContext);

  const verifier: AuthVerifier | null =
    cfg.AUTH_MODE === 'firebase'
      ? new FirebaseAuthVerifier(cfg.FIREBASE_PROJECT_ID ?? cfg.GCP_PROJECT_ID)
      : null;

  app.addHook('onRequest', async (request) => {
    const tenantHeader = headerString(request, 'x-brayz-tenant-id');

    // Dev mode: header-based, no token, no DB write.
    if (!verifier) {
      request.auth = { email: headerString(request, 'x-brayz-user-email'), tenantId: tenantHeader };
      return;
    }

    // Firebase mode.
    const identity = await verifier.verify(request);
    if (!identity) {
      request.auth = {};
      return;
    }

    // Provision/link the user. Match by authSubject first (returning user). If
    // none, and the provider has verified the email, adopt a pre-existing row with
    // that email (e.g. one created under dev mode, authSubject "dev:<email>") by
    // pointing its authSubject at the Firebase uid — this avoids a unique-email
    // collision and links the same person across auth modes. The email_verified
    // gate stops an unverified email/password sign-up from hijacking an account.
    let user = await prisma.user.findUnique({ where: { authSubject: identity.subject } });
    if (user) {
      if (identity.email && identity.email !== user.email) {
        user = await prisma.user.update({ where: { id: user.id }, data: { email: identity.email } });
      }
    } else {
      const existingByEmail =
        identity.email && identity.emailVerified
          ? await prisma.user.findUnique({ where: { email: identity.email } })
          : null;
      user = existingByEmail
        ? await prisma.user.update({
            where: { id: existingByEmail.id },
            data: { authSubject: identity.subject },
          })
        : await prisma.user.create({
            data: {
              authSubject: identity.subject,
              email: identity.email ?? `${identity.subject}@users.noreply.brayz.ai`,
            },
          });
    }

    let tenantId: string | undefined;
    if (tenantHeader) {
      const membership = await prisma.userTenantMembership.findFirst({
        where: { tenantId: tenantHeader, userId: user.id },
        select: { id: true },
      });
      if (membership) tenantId = tenantHeader;
    }

    request.auth = { userId: user.id, email: user.email, tenantId };
  });
}

function headerString(request: FastifyRequest, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Require an authenticated tenant context; returns the tenantId or throws 401. */
export function requireTenant(request: FastifyRequest): string {
  const tenantId = request.auth?.tenantId;
  if (!tenantId) {
    throw unauthorized('Missing tenant context');
  }
  return tenantId;
}

/**
 * Require that the caller holds at least `minRole` in the given tenant. With dev
 * auth (no membership rows) this passes when a tenant context is present; with
 * real users/memberships it enforces the membership role.
 */
export async function requireTenantRole(
  request: FastifyRequest,
  tenantId: string,
  minRole: Role,
): Promise<void> {
  if (request.auth?.tenantId !== tenantId) {
    throw forbidden('Tenant mismatch');
  }
  const userId = request.auth?.userId;
  const email = request.auth?.email;
  if (!userId && !email) return; // dev mode: header-only tenant context

  const membership = await prisma.userTenantMembership.findFirst({
    where: { tenantId, ...(userId ? { userId } : { user: { email } }) },
    select: { role: true },
  });
  if (!membership) return; // no membership rows yet — allow (Phase 0/1 bootstrap)
  if (!roleAtLeast(membership.role as Role, minRole)) {
    throw forbidden(`Requires role >= ${minRole}`);
  }
}
