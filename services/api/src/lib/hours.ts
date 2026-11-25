/**
 * Opening hours as arithmetic: is the restaurant open right now, when does it
 * open next, and is the time a caller asked for one it can actually cook at.
 *
 * Kept pure and away from Prisma so it can be tested without a database, and
 * kept in one file because the answer has to be the same everywhere it is
 * asked — Insights counts a call as after-hours by the same rule the bot uses
 * to tell a caller it is closed.
 *
 * Everything here works in the location's own timezone. A restaurant's day
 * ends when it closes, not at UTC midnight, and a kitchen open until 1am is
 * open at half past midnight — `closesAt` past 24 h carries the previous day
 * into this one.
 */

/** A location's weekly opening hours; minutes from local midnight, 0 = Sunday. */
export interface OpenInterval {
  dayOfWeek: number;
  opensAt: number;
  closesAt: number;
}

/** A dated override: closed for the day, or open at different times. */
export interface HolidayInterval {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  closed: boolean;
  opensAt: number | null;
  closesAt: number | null;
}

const DAY_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;

/** A minute-count past midnight, the local weekday, and the local date. */
export function localParts(at: Date, tz: string): { dayOfWeek: number; minutes: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Hour 24 is midnight in this formatter; a day starts at 0.
  const hour = Number(get('hour')) % 24;
  return {
    dayOfWeek: Math.max(0, days.indexOf(get('weekday'))),
    minutes: hour * 60 + Number(get('minute')),
    date: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/**
 * Was the restaurant open at that moment? A holiday row replaces the weekly
 * hours for its date, closed or not. An interval that closes past midnight
 * (`closesAt` over 24 h) keeps the previous day open into this one — a kitchen
 * open until 1am is open at half past midnight, not shut all Saturday.
 */
export function isOpenAt(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): boolean {
  const { dayOfWeek, minutes, date } = localParts(at, tz);
  const holiday = holidays.find((h) => h.date === date);
  if (holiday) {
    if (holiday.closed || holiday.opensAt == null || holiday.closesAt == null) return false;
    return minutes >= holiday.opensAt && minutes < holiday.closesAt;
  }
  const today = hours.some(
    (h) => h.dayOfWeek === dayOfWeek && minutes >= h.opensAt && minutes < h.closesAt,
  );
  if (today) return true;
  const yesterday = (dayOfWeek + 6) % 7;
  return hours.some(
    (h) => h.dayOfWeek === yesterday && h.closesAt > DAY_MINUTES && minutes + DAY_MINUTES < h.closesAt,
  );
}

/** How far ahead of UTC the zone is at that instant, in milliseconds. */
function zoneOffsetMs(at: Date, tz: string): number {
  const { date, minutes } = localParts(at, tz);
  const [y, m, d] = date.split('-').map(Number);
  const asIfUtc = Date.UTC(y!, m! - 1, d!, 0, minutes);
  // localParts has minute resolution, so compare against the same.
  return asIfUtc - Math.floor(at.getTime() / MINUTE_MS) * MINUTE_MS;
}

/**
 * The instant at which a local wall-clock time falls. `minutes` may run past
 * 24 h for a closing time after midnight.
 *
 * The offset has to be read at the answer, not the guess: on the March jump an
 * offset read at UTC midnight is an hour out for an 11am opening, so the guess
 * is corrected once and re-checked.
 */
export function zonedTimeToUtc(date: string, minutes: number, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!, 0, minutes);
  const first = guess - zoneOffsetMs(new Date(guess), tz);
  const second = guess - zoneOffsetMs(new Date(first), tz);
  return new Date(second);
}

/** The local date `days` after (or before) this one. */
export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + days));
  return at.toISOString().slice(0, 10);
}

/**
 * Day names a caller says, indexed like `Date.getDay()`. "Wednesday" means the
 * next one — today, if today is Wednesday. The model passes the name rather
 * than a date because it is not told what today's date is and must not guess:
 * on the call of 2026-09-14 it turned "Wednesday" into a date twelve days gone.
 */
export const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/** 0 = Sunday, for a local calendar date. */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** The windows this local date is open for, holiday overrides winning. */
function windowsOn(
  date: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[],
): Array<{ opensAt: number; closesAt: number }> {
  const holiday = holidays.find((h) => h.date === date);
  if (holiday) {
    if (holiday.closed || holiday.opensAt == null || holiday.closesAt == null) return [];
    return [{ opensAt: holiday.opensAt, closesAt: holiday.closesAt }];
  }
  return hours
    .filter((h) => h.dayOfWeek === weekdayOf(date))
    .map((h) => ({ opensAt: h.opensAt, closesAt: h.closesAt }))
    .sort((a, b) => a.opensAt - b.opensAt);
}

/**
 * The next moment the doors open at or after `at`, or null if nothing in the
 * next `horizonDays` does. A restaurant that is open right now returns the
 * moment its current window opened — callers asking "when do you open next"
 * should check `isOpenAt` first.
 */
export function nextOpenAt(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
  horizonDays = 8,
): Date | null {
  if (!hours.length && !holidays.length) return null;
  const { date } = localParts(at, tz);
  for (let i = 0; i <= horizonDays; i += 1) {
    const day = addLocalDays(date, i);
    for (const w of windowsOn(day, hours, holidays)) {
      const opens = zonedTimeToUtc(day, w.opensAt, tz);
      if (opens.getTime() >= at.getTime()) return opens;
    }
  }
  return null;
}

/**
 * When the stretch of opening that `at` falls in began, or null if it is not
 * open. Windows that meet (lunch until three, three until close) are one
 * stretch: the kitchen did not stop at three.
 */
export function openSince(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): Date | null {
  let since: Date | null = null;
  let probe = at;
  // Bounded: a week of back-to-back windows is a kitchen that never closes.
  for (let i = 0; i < 21; i += 1) {
    const opens = windowAt(probe, tz, hours, holidays)?.opens;
    if (!opens) break;
    since = opens;
    probe = new Date(opens.getTime() - MINUTE_MS);
  }
  return since;
}

/** The window open at `at`, as instants. */
function windowAt(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[],
): { opens: Date; closes: Date } | null {
  const { date } = localParts(at, tz);
  // Yesterday first: a window that runs past midnight is the one still open.
  for (const day of [addLocalDays(date, -1), date]) {
    for (const w of windowsOn(day, hours, holidays)) {
      const opens = zonedTimeToUtc(day, w.opensAt, tz);
      const closes = zonedTimeToUtc(day, w.closesAt, tz);
      if (at.getTime() >= opens.getTime() && at.getTime() < closes.getTime()) {
        return { opens, closes };
      }
    }
  }
  return null;
}

/** When the window that is open at `at` shuts, or null if it is not open. */
export function closesAfter(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): Date | null {
  return windowAt(at, tz, hours, holidays)?.closes ?? null;
}

export interface OpenState {
  /** Open right now. False when no hours are saved at all — see `known`. */
  open: boolean;
  /** Whether this location has any hours to judge by. */
  known: boolean;
  /** When the doors open next (null when open, or when nothing is scheduled). */
  nextOpen: Date | null;
  /** When the current window shuts (null when closed). */
  closes: Date | null;
}

/**
 * Everything the bot needs to decide how to answer this call. A location with
 * no hours saved is reported as `known: false` and treated as open — the same
 * posture Insights takes, and the only honest one: we do not know it is shut,
 * and refusing a real order on a guess is worse than taking one.
 */
export function openStateAt(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): OpenState {
  if (!hours.length && !holidays.length) return { open: true, known: false, nextOpen: null, closes: null };
  const open = isOpenAt(at, tz, hours, holidays);
  return {
    open,
    known: true,
    nextOpen: open ? null : nextOpenAt(at, tz, hours, holidays),
    closes: open ? closesAfter(at, tz, hours, holidays) : null,
  };
}

/**
 * The instant a caller meant by a clock time and a day. `day` is today,
 * tomorrow, or a local date; the model never computes the instant itself
 * because it does not know the restaurant's timezone.
 */
export function resolveRequestedTime(
  request: { time: string; day?: string },
  now: Date,
  tz: string,
): Date | null {
  const [h, m] = request.time.split(':').map(Number);
  if (h == null || m == null || Number.isNaN(h) || Number.isNaN(m)) return null;
  const today = localParts(now, tz).date;
  const asked = request.day?.trim().toLowerCase();
  const weekday = asked ? (WEEKDAYS as readonly string[]).indexOf(asked) : -1;
  const day =
    !asked || asked === 'today'
      ? today
      : asked === 'tomorrow'
        ? addLocalDays(today, 1)
        : weekday >= 0
          ? addLocalDays(today, (weekday - weekdayOf(today) + 7) % 7)
          : asked;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return zonedTimeToUtc(day, h * 60 + m, tz);
}

/** Today's date where the restaurant is, as a person says it: "Monday, September 14". */
export function spokenDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(at);
}

/** Local clock time as a person says it: "6:15 PM". */
export function spokenTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/**
 * A time with the day attached the way it would be said out loud: "today at
 * 6:15 PM", "tomorrow at 11:00 AM", "Friday at 11:00 AM". Anything past a week
 * gets a date, because "Friday" by then means the wrong Friday.
 */
export function spokenWhen(at: Date, now: Date, tz: string): string {
  const today = localParts(now, tz).date;
  const on = localParts(at, tz).date;
  const time = spokenTime(at, tz);
  if (on === today) return `today at ${time}`;
  if (on === addLocalDays(today, 1)) return `tomorrow at ${time}`;
  const within = (Date.parse(`${on}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(at);
  if (within > 0 && within < 7) return `${weekday} at ${time}`;
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', day: 'numeric' }).format(at);
  return `${weekday}, ${date} at ${time}`;
}

/** "11:00 AM to 10:00 PM", or null when the day has no hours. */
export function spokenHoursOn(
  date: string,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): string | null {
  const windows = windowsOn(date, hours, holidays);
  if (!windows.length) return null;
  return windows
    .map(
      (w) =>
        `${spokenTime(zonedTimeToUtc(date, w.opensAt, tz), tz)} to ${spokenTime(
          zonedTimeToUtc(date, w.closesAt, tz),
          tz,
        )}`,
    )
    .join(' and ');
}
