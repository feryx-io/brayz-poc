export { prisma, Prisma } from './client.js';
export type { PrismaClient } from './client.js';
export { forTenant, assertTenant } from './tenantScope.js';
export type { TenantScopedClient } from './tenantScope.js';
export { writeAudit } from './audit.js';
export type { AuditEntry } from './audit.js';
