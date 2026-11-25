import { offsetMinutes } from './time';
import type { HistogramBucket } from './queries';

/**
 * Ranges and bucket maths for the staff portal's call histogram.
 *
 * Buckets are cut in the viewer's timezone, and a range is snapped to whole
 * buckets on both ends, so the first and last bars are never a sliver of a day
 * or a month that reads as a dip. The current bucket is included while it is
 * still filling up.
 */

export type HistogramRange = '24h' | '7d' | '30d' | '90d' | '12m' | '24m';

interface RangeSpec {
  label: string;
  unit: 'hour' | 'day' | 'month';
  count: number;
  defaultBucket: HistogramBucket;
}

export const HISTOGRAM_RANGES: Record<HistogramRange, RangeSpec> = {
  '24h': { label: 'Last 24 hours', unit: 'hour', count: 24, defaultBucket: 'hour' },
  '7d': { label: 'Last 7 days', unit: 'day', count: 7, defaultBucket: 'day' },
  '30d': { label: 'Last 30 days', unit: 'day', count: 30, defaultBucket: 'day' },
  '90d': { label: 'Last 90 days', unit: 'day', count: 90, defaultBucket: 'week' },
  '12m': { label: 'Last 12 months', unit: 'month', count: 12, defaultBucket: 'month' },
  '24m': { label: 'Last 24 months', unit: 'month', count: 24, defaultBucket: 'month' },
};

export const BUCKET_LABELS: Record<HistogramBucket, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/** The most bars that still leave each one its 2px gap in a typical card. */
export const MAX_BARS = 200;

const HOUR_MS = 3_600_000;
const APPROX_MS: Record<HistogramBucket, number> = {
  hour: HOUR_MS,
  day: 24 * HOUR_MS,
  week: 7 * 24 * HOUR_MS,
  month: 30.44 * 24 * HOUR_MS,
};

/** The buckets that give `range` between 2 and MAX_BARS bars — fewer is a stat, more is a smear. */
export function bucketsFor(range: HistogramRange): HistogramBucket[] {
  const spec = HISTOGRAM_RANGES[range];
  const span = spec.count * APPROX_MS[spec.unit];
  return (['hour', 'day', 'week', 'month'] as const).filter((bucket) => {
    const bars = span / APPROX_MS[bucket];
    return bars >= 2 && bars <= MAX_BARS;
  });
}

/** A wall-clock time; fields may overflow (hour 25, day 0) until normalized. */
interface Wall {
  y: number;
  mo: number; // 1–12
  d: number;
  h: number;
}

function wallOf(at: Date, tz: string): Wall {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: n('year'), mo: n('month'), d: n('day'), h: n('hour') };
}

function norm(w: Wall): Wall {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d, w.h));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours() };
}

/** The instant a wall-clock time happens in `tz` (two passes settle a DST edge). */
function instantOf(w: Wall, tz: string): Date {
  const asUtc = Date.UTC(w.y, w.mo - 1, w.d, w.h);
  let guess = asUtc;
  for (let i = 0; i < 2; i++) guess = asUtc - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess);
}

function floorWall(w: Wall, unit: HistogramBucket): Wall {
  const n = norm(w);
  switch (unit) {
    case 'hour':
      return n;
    case 'day':
      return { ...n, h: 0 };
    case 'week': {
      // Monday, as Postgres' date_trunc('week') has it.
      const back = (new Date(Date.UTC(n.y, n.mo - 1, n.d)).getUTCDay() + 6) % 7;
      return norm({ ...n, d: n.d - back, h: 0 });
    }
    case 'month':
      return { ...n, d: 1, h: 0 };
  }
}

function addWall(w: Wall, unit: HistogramBucket, count: number): Wall {
  switch (unit) {
    case 'hour':
      return norm({ ...w, h: w.h + count });
    case 'day':
      return norm({ ...w, d: w.d + count });
    case 'week':
      return norm({ ...w, d: w.d + 7 * count });
    case 'month':
      return norm({ ...w, mo: w.mo + count });
  }
}

const sameWall = (a: Wall, b: Wall) => a.y === b.y && a.mo === b.mo && a.d === b.d && a.h === b.h;

/**
 * The [from, to) instants to ask the API for: `range` ending with the bucket
 * `now` is in, widened to whole `bucket`s. A coarser bucket than the range's
 * own unit reaches a little further back rather than starting mid-bucket.
 */
export function histogramWindow(
  range: HistogramRange,
  bucket: HistogramBucket,
  now: Date,
  tz: string,
): { from: Date; to: Date } {
  const spec = HISTOGRAM_RANGES[range];
  const current = floorWall(wallOf(now, tz), spec.unit);
  const start = addWall(current, spec.unit, -(spec.count - 1));
  const end = addWall(current, spec.unit, 1);
  const endFloor = floorWall(end, bucket);
  const to = sameWall(endFloor, end) ? endFloor : addWall(endFloor, bucket, 1);
  return { from: instantOf(floorWall(start, bucket), tz), to: instantOf(to, tz) };
}

/** A bucket's `start` (local wall clock, YYYY-MM-DDTHH:mm) as a Date to format in UTC. */
function asWallDate(start: string): Date {
  const [date = '', time = '00:00'] = start.split('T');
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1, d, hh, mm));
}

const UTC = { timeZone: 'UTC' } as const;

/** The full name of a bucket, for the tooltip and the table. */
export function bucketLabel(start: string, bucket: HistogramBucket): string {
  const d = asWallDate(start);
  switch (bucket) {
    case 'hour':
      return d.toLocaleString('en-US', { ...UTC, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' });
    case 'day':
      return d.toLocaleDateString('en-US', { ...UTC, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    case 'week':
      return `Week of ${d.toLocaleDateString('en-US', { ...UTC, month: 'short', day: 'numeric', year: 'numeric' })}`;
    case 'month':
      return d.toLocaleDateString('en-US', { ...UTC, month: 'long', year: 'numeric' });
  }
}

/** The short form for the x-axis. */
export function tickLabel(start: string, bucket: HistogramBucket): string {
  const d = asWallDate(start);
  switch (bucket) {
    case 'hour':
      return d.toLocaleString('en-US', { ...UTC, hour: 'numeric' });
    case 'day':
    case 'week':
      return d.toLocaleDateString('en-US', { ...UTC, month: 'short', day: 'numeric' });
    case 'month':
      return d.toLocaleDateString('en-US', { ...UTC, month: 'short', year: 'numeric' });
  }
}

/**
 * Round y-axis ticks from zero to at least `max`: steps of 1, 2 or 5 times a
 * power of ten, and whole numbers only — these are counts of calls.
 */
export function niceTicks(max: number, target = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag);
  const ticks: number[] = [];
  for (let t = 0; t < max + step; t += step) ticks.push(t);
  return ticks;
}
