import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  closesAfter,
  isOpenAt,
  nextOpenAt,
  openStateAt,
  resolveRequestedTime,
  spokenHoursOn,
  spokenWhen,
  zonedTimeToUtc,
  type HolidayInterval,
  type OpenInterval,
} from '../src/lib/hours.js';
import { decideSchedule, earliestSchedulable } from '../src/lib/schedule.js';

const TZ = 'America/New_York';
/** Open 11:00–22:00 every day. */
const DAILY: OpenInterval[] = [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  opensAt: 11 * 60,
  closesAt: 22 * 60,
}));
/** Friday and Saturday run to 1am. */
const LATE: OpenInterval[] = [
  { dayOfWeek: 5, opensAt: 11 * 60, closesAt: 25 * 60 },
  { dayOfWeek: 6, opensAt: 11 * 60, closesAt: 25 * 60 },
];

describe('opening hours in the restaurant’s own timezone', () => {
  it('reads a wall-clock time as the instant it happens in that zone', () => {
    // 11:00 in New York on a summer date is 15:00 UTC.
    expect(zonedTimeToUtc('2026-09-11', 11 * 60, TZ).toISOString()).toBe('2026-09-11T15:00:00.000Z');
    // And 16:00 UTC in the winter, when the offset is an hour further back.
    expect(zonedTimeToUtc('2026-01-15', 11 * 60, TZ).toISOString()).toBe('2026-01-15T16:00:00.000Z');
  });

  it('gets an opening right on the spring-forward day, where a fixed offset would not', () => {
    // 2026-03-08 is the US clock change; 11:00 local is already EDT.
    expect(zonedTimeToUtc('2026-03-08', 11 * 60, TZ).toISOString()).toBe('2026-03-08T15:00:00.000Z');
  });

  it('is shut at 8:34am and open at lunchtime', () => {
    const morning = new Date('2026-09-12T12:34:00Z'); // 08:34 EDT
    const lunch = new Date('2026-09-12T16:30:00Z'); // 12:30 EDT
    expect(isOpenAt(morning, TZ, DAILY)).toBe(false);
    expect(isOpenAt(lunch, TZ, DAILY)).toBe(true);
  });

  it('keeps a kitchen that closes at 1am open at half past midnight', () => {
    // 00:30 Saturday local, which belongs to Friday's window.
    expect(isOpenAt(new Date('2026-09-12T04:30:00Z'), TZ, LATE)).toBe(true);
    // 02:30 Saturday: that window has closed.
    expect(isOpenAt(new Date('2026-09-12T06:30:00Z'), TZ, LATE)).toBe(false);
  });

  it('opens next at 11 the same morning, and says when it closes once open', () => {
    const morning = new Date('2026-09-12T12:34:00Z');
    expect(nextOpenAt(morning, TZ, DAILY)?.toISOString()).toBe('2026-09-12T15:00:00.000Z');
    const lunch = new Date('2026-09-12T16:30:00Z');
    expect(closesAfter(lunch, TZ, DAILY)?.toISOString()).toBe('2026-09-13T02:00:00.000Z');
  });

  it('skips a holiday that is closed and opens the following day', () => {
    const holidays: HolidayInterval[] = [
      { date: '2026-09-12', closed: true, opensAt: null, closesAt: null },
    ];
    const morning = new Date('2026-09-12T12:34:00Z');
    expect(isOpenAt(morning, TZ, DAILY, holidays)).toBe(false);
    expect(nextOpenAt(morning, TZ, DAILY, holidays)?.toISOString()).toBe('2026-09-13T15:00:00.000Z');
  });

  it('treats a location with no hours as open, and says it does not know', () => {
    const state = openStateAt(new Date('2026-09-12T12:34:00Z'), TZ, []);
    expect(state).toMatchObject({ open: true, known: false, nextOpen: null });
  });

  it('says today’s hours and a time the way a person would', () => {
    expect(spokenHoursOn('2026-09-12', TZ, DAILY)).toBe('11:00 AM to 10:00 PM');
    const now = new Date('2026-09-12T12:34:00Z');
    expect(spokenWhen(new Date('2026-09-12T22:15:00Z'), now, TZ)).toBe('today at 6:15 PM');
    expect(spokenWhen(new Date('2026-09-13T15:00:00Z'), now, TZ)).toBe('tomorrow at 11:00 AM');
    expect(spokenWhen(new Date('2026-09-15T15:00:00Z'), now, TZ)).toBe('Tuesday at 11:00 AM');
  });

  it('resolves a weekday the caller named to the next one, never a past date', () => {
    // The call of 2026-09-14: the model, never told the date, turned "Wednesday"
    // into 2026-09-02. It now passes the name and the API finds the day.
    const monday = new Date('2026-09-14T14:19:00Z'); // Monday morning, local
    expect(resolveRequestedTime({ time: '18:00', day: 'wednesday' }, monday, TZ)?.toISOString()).toBe(
      '2026-09-16T22:00:00.000Z',
    );
    expect(resolveRequestedTime({ time: '18:00', day: 'Wednesday' }, monday, TZ)?.toISOString()).toBe(
      '2026-09-16T22:00:00.000Z',
    );
    // Today's own name is today; last Sunday is next Sunday.
    expect(resolveRequestedTime({ time: '18:00', day: 'monday' }, monday, TZ)?.toISOString()).toBe(
      '2026-09-14T22:00:00.000Z',
    );
    expect(resolveRequestedTime({ time: '12:00', day: 'sunday' }, monday, TZ)?.toISOString()).toBe(
      '2026-09-20T16:00:00.000Z',
    );
    expect(resolveRequestedTime({ time: '12:00', day: 'someday' }, monday, TZ)).toBeNull();
  });

  it('resolves a clock time the model heard against the right local day', () => {
    const now = new Date('2026-09-12T12:34:00Z'); // Saturday morning, local
    expect(resolveRequestedTime({ time: '18:15' }, now, TZ)?.toISOString()).toBe('2026-09-12T22:15:00.000Z');
    expect(resolveRequestedTime({ time: '11:00', day: 'tomorrow' }, now, TZ)?.toISOString()).toBe(
      '2026-09-13T15:00:00.000Z',
    );
    expect(resolveRequestedTime({ time: '12:00', day: '2026-09-20' }, now, TZ)?.toISOString()).toBe(
      '2026-09-20T16:00:00.000Z',
    );
  });

  it('counts local days, not 24-hour blocks', () => {
    expect(addLocalDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('whether an order can be made for a time', () => {
  const policy = { enabled: true, maxDaysAhead: 1, leadMinutes: 20 };
  /** Saturday 08:34 local — the restaurant is shut, it opens at 11. */
  const now = new Date('2026-09-12T12:34:00Z');

  it('offers the first time the kitchen could have it, from the doors opening', () => {
    expect(earliestSchedulable(now, TZ, DAILY, [], 20)?.toISOString()).toBe('2026-09-12T15:20:00.000Z');
    // Mid-service, it is simply the lead time from now.
    const lunch = new Date('2026-09-12T16:30:00Z');
    expect(earliestSchedulable(lunch, TZ, DAILY, [], 20)?.toISOString()).toBe('2026-09-12T16:50:00.000Z');
  });

  it('takes an order for six o’clock this evening', () => {
    const at = resolveRequestedTime({ time: '18:00' }, now, TZ);
    expect(decideSchedule(at, now, TZ, DAILY, [], policy)).toMatchObject({ ok: true });
  });

  it('refuses a time the restaurant is shut at, and offers one it is not', () => {
    const at = resolveRequestedTime({ time: '09:30' }, now, TZ);
    const decision = decideSchedule(at, now, TZ, DAILY, [], policy);
    expect(decision).toMatchObject({ ok: false, reason: 'closed_then' });
    if (!decision.ok) expect(decision.earliest?.toISOString()).toBe('2026-09-12T15:20:00.000Z');
  });

  it('refuses a time sooner than the kitchen can cook it', () => {
    const lunch = new Date('2026-09-12T16:30:00Z');
    const at = resolveRequestedTime({ time: '12:40' }, lunch, TZ); // ten minutes away
    expect(decideSchedule(at, lunch, TZ, DAILY, [], policy)).toMatchObject({
      ok: false,
      reason: 'too_soon',
    });
  });

  it('counts the lead time from the doors opening, not from ten minutes before', () => {
    // 10:50 local, opening at 11:00, twenty minutes to cook: 11:20, not 11:10.
    const beforeOpening = new Date('2026-09-12T14:50:00Z');
    expect(earliestSchedulable(beforeOpening, TZ, DAILY, [], 20)?.toISOString()).toBe(
      '2026-09-12T15:20:00.000Z',
    );
    const tenPast = resolveRequestedTime({ time: '11:10' }, beforeOpening, TZ);
    const decision = decideSchedule(tenPast, beforeOpening, TZ, DAILY, [], policy);
    expect(decision).toMatchObject({ ok: false, reason: 'too_soon' });
    if (!decision.ok) expect(decision.earliest?.toISOString()).toBe('2026-09-12T15:20:00.000Z');
    const twentyPast = resolveRequestedTime({ time: '11:20' }, beforeOpening, TZ);
    expect(decideSchedule(twentyPast, beforeOpening, TZ, DAILY, [], policy)).toMatchObject({
      ok: true,
    });
  });

  it('treats windows that meet as one stretch of cooking', () => {
    const split: OpenInterval[] = [0, 1, 2, 3, 4, 5, 6].flatMap((dayOfWeek) => [
      { dayOfWeek, opensAt: 11 * 60, closesAt: 15 * 60 },
      { dayOfWeek, opensAt: 15 * 60, closesAt: 22 * 60 },
    ]);
    const lateLunch = new Date('2026-09-12T18:50:00Z'); // 14:50 local
    const fivePast = resolveRequestedTime({ time: '15:10' }, lateLunch, TZ);
    expect(decideSchedule(fivePast, lateLunch, TZ, split, [], policy)).toMatchObject({ ok: true });
  });

  it('refuses a time that has already gone by', () => {
    const at = resolveRequestedTime({ time: '07:00' }, now, TZ);
    expect(decideSchedule(at, now, TZ, DAILY, [], policy)).toMatchObject({ ok: false, reason: 'past' });
  });

  it('offers the furthest day it takes orders for when asked about a later one', () => {
    // The call of 2026-09-14: asked for Wednesday at six on a Monday with one
    // day ahead allowed, the caller was offered only "today at 11:20".
    const wednesday = resolveRequestedTime({ time: '18:00', day: '2026-09-16' }, now, TZ);
    const decision = decideSchedule(wednesday, now, TZ, DAILY, [], policy);
    expect(decision).toMatchObject({ ok: false, reason: 'too_far' });
    if (!decision.ok) {
      // Tomorrow (the 13th, local) at the same six o'clock.
      expect(decision.latest?.toISOString()).toBe('2026-09-13T22:00:00.000Z');
    }
    // A time the restaurant is shut on that last day has no same-time offer.
    const lateNight = resolveRequestedTime({ time: '23:30', day: '2026-09-16' }, now, TZ);
    const shut = decideSchedule(lateNight, now, TZ, DAILY, [], policy);
    if (!shut.ok) expect(shut.latest).toBeNull();
  });

  it('refuses a day further ahead than the location allows, by calendar days', () => {
    const tomorrowEvening = resolveRequestedTime({ time: '18:00', day: 'tomorrow' }, now, TZ);
    expect(decideSchedule(tomorrowEvening, now, TZ, DAILY, [], policy)).toMatchObject({ ok: true });
    const dayAfter = resolveRequestedTime({ time: '18:00', day: '2026-09-14' }, now, TZ);
    expect(decideSchedule(dayAfter, now, TZ, DAILY, [], policy)).toMatchObject({
      ok: false,
      reason: 'too_far',
    });
  });

  it('refuses everything when the location does not take orders ahead', () => {
    const at = resolveRequestedTime({ time: '18:00' }, now, TZ);
    expect(decideSchedule(at, now, TZ, DAILY, [], { ...policy, enabled: false })).toMatchObject({
      ok: false,
      reason: 'disabled',
    });
  });

  it('will not judge a time for a location with no hours saved', () => {
    const at = resolveRequestedTime({ time: '18:00' }, now, TZ);
    expect(decideSchedule(at, now, TZ, [], [], policy)).toMatchObject({
      ok: false,
      reason: 'hours_unknown',
    });
  });
});
