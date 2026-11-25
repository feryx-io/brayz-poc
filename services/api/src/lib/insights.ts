/**
 * The parts of Insights that are arithmetic rather than SQL, kept pure so they
 * can be tested without a database.
 *
 * The one that needs care is "missed calls prevented". It would be easy, and
 * flattering, to count every answered call — but a restaurant that would have
 * picked up anyway was not saved anything. What Brayz genuinely prevented is a
 * call that would have rung out: one that came in **outside opening hours**, or
 * one that arrived **while another call was already on the line**. Those are
 * the two ways a phone goes unanswered in a restaurant with one handset, and
 * both are facts the call records already hold.
 */

/**
 * Opening hours live in `hours.ts` — the bot tells a caller the restaurant is
 * shut by the same rule that counts the call here. Re-exported so the Insights
 * tests and route keep one import.
 */
export {
  isOpenAt,
  localParts,
  type HolidayInterval,
  type OpenInterval,
} from './hours.js';
import { isOpenAt, type HolidayInterval, type OpenInterval } from './hours.js';

/** Only what the rung-out count needs from a call. */
export interface CallWindow {
  startedAt: Date;
  endedAt: Date | null;
}

export interface RungOutCount {
  /** Answered when the restaurant was shut. */
  afterHours: number;
  /** Answered while an earlier call was still on the line. */
  whileBusy: number;
  /** Calls that were one, the other, or both — never double-counted. */
  total: number;
}

/**
 * How many of these calls would have rung out without Brayz. A call still in
 * progress (no end) is counted for itself, but never used to say a later call
 * was competing with it — an unfinished row is as often a lost end event as a
 * live call, and it must not inflate the number.
 */
export function callsThatWouldHaveRungOut(
  calls: CallWindow[],
  tz: string,
  hours: OpenInterval[],
  holidays: HolidayInterval[] = [],
): RungOutCount {
  const ordered = [...calls].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  let afterHours = 0;
  let whileBusy = 0;
  let total = 0;
  // The latest moment any earlier call was still connected.
  let busyUntil = 0;
  for (const call of ordered) {
    const closed = hours.length > 0 && !isOpenAt(call.startedAt, tz, hours, holidays);
    const busy = call.startedAt.getTime() < busyUntil;
    if (closed) afterHours += 1;
    if (busy) whileBusy += 1;
    if (closed || busy) total += 1;
    if (call.endedAt) busyUntil = Math.max(busyUntil, call.endedAt.getTime());
  }
  return { afterHours, whileBusy, total };
}

/** The smallest a bucket can be, for refusing a range that would draw thousands of bars. */
export const BUCKET_MS: Record<'hour' | 'day' | 'week' | 'month', number> = {
  hour: 3_600_000,
  day: 24 * 3_600_000,
  week: 7 * 24 * 3_600_000,
  // February, so the guard errs towards refusing rather than allowing.
  month: 28 * 24 * 3_600_000,
};

/** Postgres returns COUNT/SUM as bigint; the wire wants a number. */
export function toNumber(value: bigint | number | null): number {
  return value == null ? 0 : Number(value);
}

/**
 * How many options are listed under one group of a favourite item, and how
 * many groups. Enough to answer "which sauce did the wings go out with, and
 * which dip", not so many that a build-your-own pizza's twenty-seven toppings
 * bury the item they belong to.
 */
export const OPTIONS_PER_GROUP = 6;
export const GROUPS_PER_ITEM = 4;

/** What the menu calls an option's group when the option no longer has one. */
export const UNGROUPED = 'Other';

/** One chosen option, as the breakdown query returns it. */
export interface OptionRow {
  group_name: string | null;
  option: string;
  quantity: bigint | number;
}

export interface OptionGroup {
  name: string;
  options: Array<{ name: string; quantity: number }>;
}

/**
 * Fold the chosen options of one item into the groups the menu keeps them in.
 *
 * A sauce and a dip are two questions, and listing them together — "17 BBQ · 6
 * Ranch · 4 Buffalo (Medium)" — reads as one list of flavours with a dip
 * hidden in the middle of it. Groups come back biggest first, options biggest
 * first inside each, and an option the menu can no longer place is kept under
 * "Other" rather than dropped or filed under a group it never belonged to.
 */
export function groupOptions(
  rows: OptionRow[],
  // The overview trims both, because the point there is a glance. The menu
  // view and its export pass Infinity: a breakdown that quietly drops the
  // seventh topping is not a record of what was sold.
  caps: { groupsPerItem?: number; optionsPerGroup?: number } = {},
): OptionGroup[] {
  const groupsPerItem = caps.groupsPerItem ?? GROUPS_PER_ITEM;
  const optionsPerGroup = caps.optionsPerGroup ?? OPTIONS_PER_GROUP;
  const groups = new Map<string, { total: number; options: Array<{ name: string; quantity: number }> }>();
  for (const row of rows) {
    const name = row.group_name?.trim() || UNGROUPED;
    const quantity = toNumber(row.quantity);
    const group = groups.get(name) ?? { total: 0, options: [] };
    group.total += quantity;
    group.options.push({ name: row.option, quantity });
    groups.set(name, group);
  }
  return [...groups.entries()]
    // "Other" is what we could not place, so it sits last whatever its size.
    .sort(([aName, a], [bName, b]) =>
      aName === UNGROUPED ? 1 : bName === UNGROUPED ? -1 : b.total - a.total,
    )
    .slice(0, groupsPerItem)
    .map(([name, group]) => ({
      name,
      options: group.options.sort((a, b) => b.quantity - a.quantity).slice(0, optionsPerGroup),
    }));
}
