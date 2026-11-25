import { describe, expect, it } from 'vitest';
import { bucketLabel, bucketsFor, histogramWindow, niceTicks, tickLabel } from '../lib/histogram';

const NY = 'America/New_York';

describe('histogram ranges', () => {
  it('offers only buckets that make between 2 and 200 bars', () => {
    expect(bucketsFor('24h')).toEqual(['hour']);
    expect(bucketsFor('7d')).toEqual(['hour', 'day']);
    expect(bucketsFor('30d')).toEqual(['day', 'week']);
    expect(bucketsFor('90d')).toEqual(['day', 'week', 'month']);
    expect(bucketsFor('12m')).toEqual(['week', 'month']);
  });

  it('ends a day range at the next local midnight and starts it on a whole day', () => {
    // 2026-09-11 14:30 in New York (EDT, UTC-4).
    const now = new Date('2026-09-11T18:30:00Z');
    const { from, to } = histogramWindow('7d', 'day', now, NY);
    expect(from.toISOString()).toBe('2026-09-05T04:00:00.000Z'); // Sep 5, 00:00 EDT
    expect(to.toISOString()).toBe('2026-09-12T04:00:00.000Z'); // Sep 12, 00:00 EDT
  });

  it('keeps whole local days across a DST change', () => {
    // Clocks go back on 2026-11-01 in New York, so this week is 169 hours.
    const now = new Date('2026-11-04T17:00:00Z');
    const { from, to } = histogramWindow('7d', 'day', now, NY);
    expect(from.toISOString()).toBe('2026-10-29T04:00:00.000Z'); // Oct 29, 00:00 EDT
    expect(to.toISOString()).toBe('2026-11-05T05:00:00.000Z'); // Nov 5, 00:00 EST
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(7 * 24 + 1);
  });

  it('covers the last 24 whole hours, including the one in progress', () => {
    const now = new Date('2026-09-11T18:30:00Z');
    const { from, to } = histogramWindow('24h', 'hour', now, NY);
    expect(to.toISOString()).toBe('2026-09-11T19:00:00.000Z');
    expect(from.toISOString()).toBe('2026-09-10T19:00:00.000Z');
  });

  it('snaps a coarser bucket back to its own start — a week starts on Monday', () => {
    const now = new Date('2026-09-11T18:30:00Z'); // a Friday
    const { from, to } = histogramWindow('30d', 'week', now, NY);
    // 30 days back is Aug 13 (a Thursday); its week began Monday Aug 10.
    expect(from.toISOString()).toBe('2026-08-10T04:00:00.000Z');
    // The range ends at Sep 12 00:00, mid-week, so the last bar runs to Monday Sep 14.
    expect(to.toISOString()).toBe('2026-09-14T04:00:00.000Z');
  });

  it('covers the last 12 calendar months, this one included', () => {
    const now = new Date('2026-09-11T18:30:00Z');
    const { from, to } = histogramWindow('12m', 'month', now, NY);
    expect(from.toISOString()).toBe('2025-10-01T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-10-01T04:00:00.000Z');
  });
});

describe('histogram labels and ticks', () => {
  it('names buckets from their local wall-clock start, whatever the browser zone', () => {
    expect(bucketLabel('2026-09-11T14:00', 'hour')).toBe('Fri, Sep 11, 2 PM');
    expect(bucketLabel('2026-09-11T00:00', 'day')).toBe('Fri, Sep 11, 2026');
    expect(bucketLabel('2026-09-07T00:00', 'week')).toBe('Week of Sep 7, 2026');
    expect(bucketLabel('2026-09-01T00:00', 'month')).toBe('September 2026');
    expect(tickLabel('2026-09-11T14:00', 'hour')).toBe('2 PM');
    expect(tickLabel('2026-09-11T00:00', 'day')).toBe('Sep 11');
  });

  it('rounds ticks to whole, clean numbers that reach the peak', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(42)).toEqual([0, 20, 40, 60]);
    expect(niceTicks(1200)).toEqual([0, 500, 1000, 1500]);
  });
});
