import type { FastifyBaseLogger } from 'fastify';
import { forTenant, prisma, writeAudit } from '@brayz/db';
import { parseObjectUri, type RecordingStorage } from './recordingStorage.js';

/**
 * Per-location recording retention.
 *
 * The bucket's lifecycle rule is the platform ceiling — it deletes every
 * recording older than N days regardless of who it belongs to. A location that
 * wants recordings gone sooner sets `recordingRetentionDays`, and this sweep
 * enforces it: find calls past the cutoff that still have a recording, delete
 * the object, and mark the call so the dashboard says what happened.
 *
 * Properties this has to hold:
 *
 * - **Tenant-scoped** (rule #1). Every query carries the location's tenant;
 *   nothing here can reach across one.
 * - **Idempotent** (rule #7). The scheduler will run it again, a run can die
 *   halfway, and the bucket rule may delete an object first. Deleting the
 *   object before touching the row means a crash between the two leaves a row
 *   the next run re-processes, and a store that answers "missing" counts as
 *   done — so no ordering of failures leaves a recording orphaned or a row
 *   claiming an object that is gone.
 * - **Audited** (rule #6). A recording ceasing to exist is a record-keeping
 *   event, written against the call the way `recording.stored` was.
 * - **Bounded**. One run deletes at most `batch` per location; anything left
 *   waits for the next run rather than holding a request open.
 */

export interface SweepOptions {
  storage: RecordingStorage;
  log: FastifyBaseLogger;
  /** Per-location cap per run. */
  batch: number;
  now?: Date;
}

export interface SweepResult {
  /** Locations with a retention policy. */
  locations: number;
  /** Calls found past their cutoff with a recording still attached. */
  scanned: number;
  /** Objects removed (or already missing) and rows cleared. */
  deleted: number;
  /** Calls left for the next run because the store refused or the URI was unreadable. */
  failed: number;
}

export async function sweepExpiredRecordings(opts: SweepOptions): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const result: SweepResult = { locations: 0, scanned: 0, deleted: 0, failed: 0 };

  const policies = await prisma.locationAiSettings.findMany({
    where: { recordingRetentionDays: { not: null } },
    select: {
      locationId: true,
      recordingRetentionDays: true,
      location: { select: { tenantId: true } },
    },
  });
  result.locations = policies.length;

  for (const policy of policies) {
    const days = policy.recordingRetentionDays;
    if (days == null) continue;
    const tenantId = policy.location.tenantId;
    const locationId = policy.locationId;
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const db = forTenant(tenantId);

    const expired = await db.call.findMany({
      where: {
        locationId,
        recordingStatus: 'uploaded',
        recordingUrl: { not: null },
        startedAt: { lt: cutoff },
      },
      select: { id: true, recordingUrl: true },
      orderBy: { startedAt: 'asc' },
      take: opts.batch,
    });
    result.scanned += expired.length;

    for (const call of expired) {
      const loc = call.recordingUrl ? parseObjectUri(call.recordingUrl) : null;
      if (!loc) {
        // Not ours to delete and not something a retry will fix. Left on the
        // row, loudly, rather than cleared as if it had been removed.
        opts.log.error(
          { callId: call.id, tenantId, locationId, recordingUrl: call.recordingUrl },
          'recording retention: unreadable object uri',
        );
        result.failed += 1;
        continue;
      }

      let outcome: 'deleted' | 'missing';
      try {
        outcome = await opts.storage.delete(loc);
      } catch (err) {
        opts.log.warn(
          { err, callId: call.id, tenantId, locationId },
          'recording retention: delete failed, will retry next run',
        );
        result.failed += 1;
        continue;
      }

      await db.call.update({
        where: { id: call.id },
        data: { recordingStatus: 'deleted', recordingUrl: null },
      });
      await writeAudit({
        tenantId,
        locationId,
        action: 'recording.deleted',
        targetType: 'call',
        targetId: call.id,
        metadata: { reason: 'retention', retentionDays: days, object: outcome },
      });
      result.deleted += 1;
    }
  }

  opts.log.info(result, 'recording retention sweep');
  return result;
}
