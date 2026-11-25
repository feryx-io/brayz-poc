/**
 * Audit logging (CLAUDE.md rule #6: privacy is enforced in code, not just policy).
 * Write an AuditLog row for sensitive actions — guest-profile access, consent
 * changes, deletions, price/routing changes. Best-effort: a failed audit write
 * must never fail the request it's recording.
 */
import { prisma, Prisma } from './client.js';

export interface AuditEntry {
  tenantId: string;
  locationId?: string | null;
  /** The user/actor performing the action, if known (null for the voice plane). */
  actorId?: string | null;
  /** e.g. guest_profile.accessed, guest.memory.updated, consent.changed, guest.deleted */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        tenantId: entry.tenantId,
        locationId: entry.locationId ?? undefined,
        actorId: entry.actorId ?? undefined,
        action: entry.action,
        targetType: entry.targetType ?? undefined,
        targetId: entry.targetId ?? undefined,
        metadata: (entry.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch {
    // Best-effort — never throw into the request path over an audit write.
  }
}
