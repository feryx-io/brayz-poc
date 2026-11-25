import { prisma } from '@brayz/db';
import type { PlatformActor } from '../auth/platform.js';

/**
 * Record what Brayz staff did across tenants.
 *
 * `AuditLog` cannot hold these: it hangs off a single tenant, and the admin
 * portal reads many at once. The actor's email is stored alongside their id so
 * the trail still names someone after the account is deleted.
 *
 * Best-effort, like `writeAudit` — an audit failure must not turn a staff
 * member's page into a 500. The trade is deliberate and matches the existing
 * helper rather than inventing a second policy.
 */
export async function writePlatformAudit(entry: {
  actor: PlatformActor;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.platformAuditLog.create({
      data: {
        actorId: entry.actor.userId,
        actorEmail: entry.actor.email,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        metadata: (entry.metadata ?? {}) as object,
      },
    });
  } catch {
    // Never throw into the request path over an audit write.
  }
}
