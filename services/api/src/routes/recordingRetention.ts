import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@brayz/config';
import { makeRequireScheduler, type OidcVerifier } from '../auth/scheduler.js';
import { HttpError } from '../lib/http.js';
import { sweepExpiredRecordings } from '../lib/recordingRetention.js';
import { buildRecordingStorage, type RecordingStorage } from '../lib/recordingStorage.js';

export interface RecordingRetentionRouteOptions {
  /** Overrides the configured store (tests). `null` means none configured. */
  recordingStorage?: RecordingStorage | null;
  /** Overrides Google OIDC verification (tests). */
  oidcVerifier?: OidcVerifier;
}

/**
 * The retention sweep's trigger. Cloud Scheduler POSTs here on a schedule;
 * the work itself is in `lib/recordingRetention.ts` so it can be exercised
 * without HTTP. Idempotent, so a scheduler retry or an operator's manual
 * curl after one is harmless.
 */
export async function recordingRetentionRoutes(
  app: FastifyInstance,
  opts: RecordingRetentionRouteOptions = {},
): Promise<void> {
  const cfg = loadConfig();
  const storage =
    opts.recordingStorage === undefined ? buildRecordingStorage(cfg) : opts.recordingStorage;
  const requireScheduler = makeRequireScheduler({ verifier: opts.oidcVerifier });

  app.post('/v1/internal/recordings/sweep', async (request) => {
    await requireScheduler(request);
    if (!storage) {
      // Nothing to delete with. Distinct from "nothing expired" so a
      // misconfigured environment does not read as a clean run.
      throw new HttpError(503, 'Recording storage is not configured', 'recording_storage_unconfigured');
    }
    return sweepExpiredRecordings({
      storage,
      log: request.log,
      batch: cfg.RECORDING_SWEEP_BATCH,
    });
  });
}
