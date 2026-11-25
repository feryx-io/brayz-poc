import { z } from 'zod';

/** ---- Brayz staff portal ---- */

/** How the call histogram cuts time. A week starts on Monday (Postgres `date_trunc`). */
export const CallHistogramBucket = z.enum(['hour', 'day', 'week', 'month']);
export type CallHistogramBucket = z.infer<typeof CallHistogramBucket>;

/** The most buckets one histogram request may span; past it, a larger bucket is the answer. */
export const CALL_HISTOGRAM_MAX_BUCKETS = 1000;

export const AdminCallHistogramQuery = z.object({
  bucket: CallHistogramBucket.default('day'),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  // An IANA name; the route checks it is one the runtime knows.
  tz: z.string().min(1).max(64).default('UTC'),
});
export type AdminCallHistogramQuery = z.infer<typeof AdminCallHistogramQuery>;
