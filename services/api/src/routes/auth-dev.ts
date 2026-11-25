import type { FastifyInstance } from 'fastify';
import { DevRegisterInput } from '@brayz/shared';
import { loadConfig } from '@brayz/config';
import { prisma } from '@brayz/db';
import { conflict, forbidden, parse } from '../lib/http.js';

/**
 * Dev-mode self-service registration (AUTH_MODE=dev only). Creates a real `User`
 * row so that login can distinguish a known account from an unknown email — the
 * header-based dev auth itself stays passwordless. In `firebase` mode this route
 * is disabled; accounts are provisioned from verified ID tokens instead.
 */
export async function authDevRoutes(app: FastifyInstance): Promise<void> {
  const cfg = loadConfig();
  const devMode = cfg.AUTH_MODE !== 'firebase';

  app.post('/v1/auth/dev/register', async (request, reply) => {
    if (!devMode) {
      throw forbidden('Registration is handled by the identity provider in this mode');
    }
    const { email, displayName } = parse(DevRegisterInput, request.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw conflict('An account with this email already exists');
    }

    const user = await prisma.user.create({
      data: { email, displayName, authSubject: `dev:${email}` },
    });
    return reply.status(201).send({ id: user.id, email: user.email, displayName: user.displayName });
  });
}
