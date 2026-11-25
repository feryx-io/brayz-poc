/**
 * Whether an order can be made for the time a caller asked for.
 *
 * The decision lives here, not in the prompt (rule #5): the model hears "six
 * fifteen" and passes it along, and this says yes, or says no and what the
 * nearest workable time is. A model left to judge it would happily promise a
 * pizza for a Monday the restaurant is shut.
 */
import {
  addLocalDays,
  isOpenAt,
  localParts,
  nextOpenAt,
  openSince,
  zonedTimeToUtc,
  type HolidayInterval,
  type OpenInterval,
} from './hours.js';

export interface SchedulePolicy {
  /** Does this location take orders for later at all? */
  enabled: boolean;
  /** How many days past today it will take one for. 0 is today only. */
  maxDaysAhead: number;
  /** What the kitchen needs before an order can be ready — its own ETA. */
  leadMinutes: number;
}

export type ScheduleRefusal =
  /** The location does not take orders for later. */
  | 'disabled'
  /** A time that has already gone by. */
  | 'past'
  /** Sooner than the kitchen can make it. */
  | 'too_soon'
  /** The restaurant is shut at that hour. */
  | 'closed_then'
  /** Further out than this location will take. */
  | 'too_far'
  /** No hours saved, so nothing can be judged against them. */
  | 'hours_unknown';

export type ScheduleDecision =
  | { ok: true; at: Date }
  | {
      ok: false;
      reason: ScheduleRefusal;
      earliest: Date | null;
      /**
       * For `too_far` only: the same clock time on the last day this location
       * takes orders for, when that works. A caller asking about Wednesday
       * wants the furthest day on offer, not "today at 11:20" — which is all
       * the call of 2026-09-14 was offered, until the caller thought of
       * tomorrow themselves.
       */
      latest?: Date | null;
    };

const MINUTE_MS = 60_000;

/**
 * Could an order be ready at `at`? Open then, and open for the whole of the
 * kitchen's lead time before it: a kitchen that opens at eleven has not been
 * cooking since ten to, so eleven-ten is not a promise it can keep.
 */
function kitchenReadyBy(
  at: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[],
  leadMinutes: number,
): boolean {
  if (!isOpenAt(at, tz, hours, holidays)) return false;
  const since = openSince(at, tz, hours, holidays);
  return !since || since.getTime() <= at.getTime() - leadMinutes * MINUTE_MS;
}

/**
 * The soonest an order could be promised: the kitchen's lead time from now if
 * the restaurant is open through it, otherwise the lead time from the next
 * opening. Null when the hours never open again inside the horizon.
 */
export function earliestSchedulable(
  now: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[],
  leadMinutes: number,
  horizonDays = 8,
): Date | null {
  const soonest = new Date(now.getTime() + leadMinutes * MINUTE_MS);
  if (kitchenReadyBy(soonest, tz, hours, holidays, leadMinutes)) return soonest;
  let from = now;
  for (let i = 0; i <= horizonDays; i += 1) {
    const opens = nextOpenAt(from, tz, hours, holidays, horizonDays);
    if (!opens) return null;
    // A kitchen that opens at eleven is not cooking a caller's order at eleven
    // sharp, so the first promise is the lead time past the doors opening —
    // unless it would fall past closing, in which case try the next window.
    const ready = new Date(Math.max(opens.getTime(), now.getTime()) + leadMinutes * MINUTE_MS);
    if (kitchenReadyBy(ready, tz, hours, holidays, leadMinutes)) return ready;
    from = new Date(opens.getTime() + MINUTE_MS);
  }
  return null;
}

/**
 * Can this order be made for that moment? Refusals carry the earliest time
 * that would work, so the bot always has something to offer instead of a dead
 * end.
 */
export function decideSchedule(
  at: Date | null,
  now: Date,
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[],
  policy: SchedulePolicy,
): ScheduleDecision {
  const earliest = () => earliestSchedulable(now, tz, hours, holidays, policy.leadMinutes);
  if (!policy.enabled) return { ok: false, reason: 'disabled', earliest: null };
  if (!hours.length && !holidays.length) return { ok: false, reason: 'hours_unknown', earliest: null };
  if (!at || Number.isNaN(at.getTime())) return { ok: false, reason: 'past', earliest: earliest() };
  if (at.getTime() <= now.getTime()) return { ok: false, reason: 'past', earliest: earliest() };

  // The window a location will look ahead over, to the end of the last day it
  // allows. Measured in local days: "two days ahead" is a calendar promise, not
  // forty-eight hours.
  const today = localParts(now, tz).date;
  const lastDay = addLocalDays(today, policy.maxDaysAhead);
  const horizon = zonedTimeToUtc(lastDay, 24 * 60, tz);
  if (at.getTime() >= horizon.getTime()) {
    const sameTime = zonedTimeToUtc(lastDay, localParts(at, tz).minutes, tz);
    const latest =
      sameTime.getTime() >= now.getTime() + policy.leadMinutes * MINUTE_MS &&
      kitchenReadyBy(sameTime, tz, hours, holidays, policy.leadMinutes)
        ? sameTime
        : null;
    return { ok: false, reason: 'too_far', earliest: earliest(), latest };
  }

  if (at.getTime() < now.getTime() + policy.leadMinutes * MINUTE_MS)
    return { ok: false, reason: 'too_soon', earliest: earliest() };
  if (!isOpenAt(at, tz, hours, holidays)) return { ok: false, reason: 'closed_then', earliest: earliest() };
  // Open then, but not for long enough before it to have made the order.
  if (!kitchenReadyBy(at, tz, hours, holidays, policy.leadMinutes))
    return { ok: false, reason: 'too_soon', earliest: earliest() };
  return { ok: true, at };
}
