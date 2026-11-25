/**
 * True when the runtime knows `tz` as an IANA zone. Routes that group by a
 * caller-supplied timezone check this first, so a typo is a 400 rather than a
 * Postgres error. The zone itself always reaches SQL as a bound parameter,
 * never interpolated.
 */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
