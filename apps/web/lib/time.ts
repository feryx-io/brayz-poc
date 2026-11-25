/**
 * Calendar days in a restaurant's own timezone.
 *
 * A call at 12:30 am in New York belongs to that evening's service, and the
 * browser reading the dashboard may be anywhere. So a "day" is a YYYY-MM-DD
 * key in the location's zone, and these turn such a key into the UTC instants
 * the API filters on, and back.
 */

/** The YYYY-MM-DD a moment falls on in `tz`. */
export function dayKeyInTz(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Minutes that `tz` is ahead of UTC at instant `d`. */
export function offsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(d);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'));
  return Math.round((asUtc - d.getTime()) / 60_000);
}

/** The instant local midnight starts on `dayKey` in `tz`. */
export function startOfDayInTz(dayKey: string, tz: string): Date {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  // First guess treats local midnight as UTC midnight, then corrects by the
  // zone's offset at that guess; a second pass settles a DST boundary.
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - offsetMinutes(new Date(guess), tz) * 60_000;
  return new Date(guess);
}

/** `dayKey` moved by `days` calendar days (negative for earlier). */
export function shiftDay(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** [start, end) instants covering `fromDay` through `toDay` inclusive, in `tz`. */
export function rangeInTz(fromDay: string, toDay: string, tz: string): { from: Date; to: Date } {
  return { from: startOfDayInTz(fromDay, tz), to: startOfDayInTz(shiftDay(toDay, 1), tz) };
}

/** "Thu, Sep 4" style label for a day key, in the day's own terms. */
export function dayLabel(dayKey: string, today: string): string {
  if (dayKey === today) return 'Today';
  if (dayKey === shiftDay(today, -1)) return 'Yesterday';
  const [y, m, d] = dayKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(String(y) !== today.slice(0, 4) ? { year: 'numeric' } : {}),
  });
}
