import { PrismaClient } from '@prisma/client';

/**
 * Single shared PrismaClient. Postgres (Cloud SQL) is the system of record.
 * Reuse across the process; in dev, guard against hot-reload duplication.
 */
const globalForPrisma = globalThis as unknown as { __brayzPrisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.__brayzPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__brayzPrisma = prisma;
}

export type { PrismaClient } from '@prisma/client';
export { Prisma } from '@prisma/client';
