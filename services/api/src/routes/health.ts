import type { FastifyInstance } from 'fastify';
import { prisma } from '@brayz/db';

/** Liveness/readiness probes for Cloud Run. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready', db: 'unavailable' });
    }
  });
}
