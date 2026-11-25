import { Prisma } from '@prisma/client';
import { prisma } from './client.js';

/**
 * Tenant scoping (CLAUDE.md non-negotiable #1): there is no global guest, order,
 * menu, or call. Every query against a tenant-scoped model MUST carry tenant_id.
 *
 * `forTenant(tenantId)` returns a Prisma client extended so that, for the
 * tenant-scoped models below, `tenantId` is:
 *   - merged into the `where` of every read/update/delete/count/aggregate, and
 *   - injected into `data` on create/createMany/upsert.
 *
 * This makes a cross-tenant read structurally impossible through this client.
 * Models without a direct `tenantId` column (menu categories, items, modifiers,
 * order items, …) are reached through their tenant-scoped parents.
 */
const TENANT_SCOPED_MODELS = new Set<string>([
  'Location',
  'AuditLog',
  'PhoneNumber',
  'Call',
  'Menu',
  'Guest',
  'GuestPhoneNumber',
  'Order',
  'Notification',
  'SmsConsentRecord',
  'CallMessage',
  'LoyaltyAccount',
  'LoyaltyEvent',
  'StaffProfile',
  'StaffVoiceProfile',
  'VoiceConsentRecord',
  'PosIntegration',
  'PosOrderSync',
  'Promotion',
  'PromotionRedemption',
  'LocationSubscription',
  'SupportRequest',
]);

const READ_OPS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
  'update',
  'delete',
]);

const CREATE_OPS = new Set(['create', 'createMany', 'upsert']);

export function forTenant(tenantId: string) {
  return prisma.$extends({
    name: 'tenant-scope',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!model || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          const a = (args ?? {}) as Record<string, unknown>;

          if (READ_OPS.has(operation)) {
            a.where = { ...(a.where as object | undefined), tenantId };
          }

          if (CREATE_OPS.has(operation)) {
            if (operation === 'createMany') {
              const data = a.data;
              if (Array.isArray(data)) {
                a.data = data.map((d) => ({ ...(d as object), tenantId }));
              }
            } else if (operation === 'upsert') {
              a.where = { ...(a.where as object | undefined), tenantId };
              a.create = { ...(a.create as object | undefined), tenantId };
            } else {
              a.data = { ...(a.data as object | undefined), tenantId };
            }
          }

          return query(a);
        },
      },
    },
  });
}

export type TenantScopedClient = ReturnType<typeof forTenant>;

/** Guard for service code: throw if a tenantId is missing/empty. */
export function assertTenant(tenantId: string | undefined | null): asserts tenantId is string {
  if (!tenantId) {
    throw new Prisma.PrismaClientKnownRequestError('Missing tenant scope', {
      code: 'P2025',
      clientVersion: Prisma.prismaVersion.client,
    });
  }
}
