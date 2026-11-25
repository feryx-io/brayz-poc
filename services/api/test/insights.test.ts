import { describe, expect, it } from 'vitest';
import {
  GROUPS_PER_ITEM,
  OPTIONS_PER_GROUP,
  callsThatWouldHaveRungOut,
  groupOptions,
  isOpenAt,
  localParts,
  type HolidayInterval,
  type OpenInterval,
} from '../src/lib/insights.js';

const NY = 'America/New_York';
/** Friday 2026-09-11, 14:30 in New York (EDT, UTC-4). */
const FRI_AFTERNOON = new Date('2026-09-11T18:30:00Z');
/** Friday 2026-09-11, 02:00 in New York — long shut. */
const FRI_SMALL_HOURS = new Date('2026-09-11T06:00:00Z');
/** Saturday 2026-09-12, 00:30 in New York. */
const SAT_AFTER_MIDNIGHT = new Date('2026-09-12T04:30:00Z');

/** Open Friday 11:00–22:00. */
const FRIDAY_HOURS: OpenInterval[] = [{ dayOfWeek: 5, opensAt: 11 * 60, closesAt: 22 * 60 }];

describe('local wall clock', () => {
  it('reads the weekday, the minute of the day and the date where the restaurant is', () => {
    expect(localParts(FRI_AFTERNOON, NY)).toEqual({
      dayOfWeek: 5,
      minutes: 14 * 60 + 30,
      date: '2026-09-11',
    });
    // The same instant is already Saturday in Sydney.
    expect(localParts(FRI_AFTERNOON, 'Australia/Sydney').dayOfWeek).toBe(6);
  });

  it('counts midnight as the start of the day, not the end of it', () => {
    expect(localParts(new Date('2026-09-12T04:00:00Z'), NY)).toEqual({
      dayOfWeek: 6,
      minutes: 0,
      date: '2026-09-12',
    });
  });
});

describe('was the restaurant open', () => {
  it('answers from the weekly hours', () => {
    expect(isOpenAt(FRI_AFTERNOON, NY, FRIDAY_HOURS)).toBe(true);
    expect(isOpenAt(FRI_SMALL_HOURS, NY, FRIDAY_HOURS)).toBe(false);
  });

  it('keeps a kitchen that closes after midnight open into the next day', () => {
    const lateFriday: OpenInterval[] = [{ dayOfWeek: 5, opensAt: 11 * 60, closesAt: 25 * 60 }];
    // 00:30 on Saturday belongs to Friday's shift.
    expect(isOpenAt(SAT_AFTER_MIDNIGHT, NY, lateFriday)).toBe(true);
    // And 02:00 on Friday does not belong to Thursday's, which ended at 22:00.
    expect(isOpenAt(FRI_SMALL_HOURS, NY, lateFriday)).toBe(false);
  });

  it('lets a holiday close a day that the weekly hours say is open', () => {
    const shut: HolidayInterval[] = [
      { date: '2026-09-11', closed: true, opensAt: null, closesAt: null },
    ];
    expect(isOpenAt(FRI_AFTERNOON, NY, FRIDAY_HOURS, shut)).toBe(false);
  });

  it('lets a holiday move the hours rather than only cancel them', () => {
    const shortDay: HolidayInterval[] = [
      { date: '2026-09-11', closed: false, opensAt: 16 * 60, closesAt: 20 * 60 },
    ];
    // 14:30 is before the holiday opening, though the usual Friday is open.
    expect(isOpenAt(FRI_AFTERNOON, NY, FRIDAY_HOURS, shortDay)).toBe(false);
    expect(isOpenAt(new Date('2026-09-11T21:00:00Z'), NY, FRIDAY_HOURS, shortDay)).toBe(true);
  });
});

describe('what was chosen on an item', () => {
  const row = (group: string | null, option: string, quantity: number) => ({
    group_name: group,
    option,
    quantity,
  });

  it('keeps a sauce and a dip apart', () => {
    // The first version read "17 BBQ · 6 Ranch · 4 Buffalo (Medium)" — one list
    // of flavours with a dip hidden in the middle of it.
    const groups = groupOptions([
      row('Sauce', 'BBQ', 17),
      row('Dip', 'Ranch', 6),
      row('Sauce', 'Buffalo (Medium)', 4),
      row('Sauce', 'Garlic Parmesan', 2),
    ]);
    expect(groups).toEqual([
      {
        name: 'Sauce',
        options: [
          { name: 'BBQ', quantity: 17 },
          { name: 'Buffalo (Medium)', quantity: 4 },
          { name: 'Garlic Parmesan', quantity: 2 },
        ],
      },
      { name: 'Dip', options: [{ name: 'Ranch', quantity: 6 }] },
    ]);
  });

  it('keeps an option the menu can no longer place, under Other and last', () => {
    // A request recorded ad hoc because the menu could not price it. Dropping
    // it would lose what a caller asked for; filing it under a real group
    // would say something untrue about the menu.
    const groups = groupOptions([row(null, 'Extra crispy', 99), row('Sauce', 'BBQ', 1)]);
    expect(groups.map((g) => g.name)).toEqual(['Sauce', 'Other']);
    expect(groups[1]?.options).toEqual([{ name: 'Extra crispy', quantity: 99 }]);
  });

  it('caps the options in a group and the groups on an item', () => {
    const many = Array.from({ length: OPTIONS_PER_GROUP + 3 }, (_, i) =>
      row('Toppings', `Topping ${i}`, 100 - i),
    );
    const spread = Array.from({ length: GROUPS_PER_ITEM + 2 }, (_, i) =>
      row(`Group ${i}`, 'Something', 50 - i),
    );
    expect(groupOptions(many)[0]?.options).toHaveLength(OPTIONS_PER_GROUP);
    // Biggest first, so what is cut is the tail, not the headline.
    expect(groupOptions(many)[0]?.options[0]).toEqual({ name: 'Topping 0', quantity: 100 });
    expect(groupOptions(spread)).toHaveLength(GROUPS_PER_ITEM);
  });

  it('says nothing about an item nobody chose anything on', () => {
    expect(groupOptions([])).toEqual([]);
  });
});

describe('calls that would have rung out', () => {
  const call = (startISO: string, minutes: number | null) => ({
    startedAt: new Date(startISO),
    endedAt: minutes === null ? null : new Date(new Date(startISO).getTime() + minutes * 60_000),
  });

  it('counts a call that came in while the restaurant was shut', () => {
    const counted = callsThatWouldHaveRungOut(
      [call('2026-09-11T06:00:00Z', 2), call('2026-09-11T18:30:00Z', 3)],
      NY,
      FRIDAY_HOURS,
    );
    expect(counted).toEqual({ afterHours: 1, whileBusy: 0, total: 1 });
  });

  it('counts a call that arrived while another was still on the line', () => {
    const counted = callsThatWouldHaveRungOut(
      [call('2026-09-11T18:30:00Z', 5), call('2026-09-11T18:32:00Z', 2)],
      NY,
      FRIDAY_HOURS,
    );
    expect(counted).toEqual({ afterHours: 0, whileBusy: 1, total: 1 });
  });

  it('counts a call that was both only once', () => {
    const counted = callsThatWouldHaveRungOut(
      [call('2026-09-11T06:00:00Z', 5), call('2026-09-11T06:02:00Z', 2)],
      NY,
      FRIDAY_HOURS,
    );
    expect(counted).toEqual({ afterHours: 2, whileBusy: 1, total: 2 });
  });

  it('does not let a call with no end make every later call look concurrent', () => {
    // An unfinished row is as often a lost end event as a live call.
    const counted = callsThatWouldHaveRungOut(
      [call('2026-09-11T18:30:00Z', null), call('2026-09-11T19:30:00Z', 2)],
      NY,
      FRIDAY_HOURS,
    );
    expect(counted.whileBusy).toBe(0);
  });

  it('claims nothing about after-hours when the location has no hours saved', () => {
    const counted = callsThatWouldHaveRungOut([call('2026-09-11T06:00:00Z', 2)], NY, []);
    expect(counted).toEqual({ afterHours: 0, whileBusy: 0, total: 0 });
  });
});
