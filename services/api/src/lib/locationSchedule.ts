/**
 * What the hours mean for one location, loaded once and answered the same way
 * everywhere: the profile tool that tells the bot it is closed, the schedule
 * tool that judges a time the caller asked for, and the order route that
 * refuses an order the restaurant is shut for.
 */
import { prisma } from '@brayz/db';
import {
  addLocalDays,
  localParts,
  openStateAt,
  spokenHoursOn,
  type HolidayInterval,
  type OpenInterval,
  type OpenState,
} from './hours.js';
import type { SchedulePolicy } from './schedule.js';

/** How long a holiday row stays relevant to a decision made now. */
const HOLIDAY_WINDOW_DAYS = 16;

/** Used when a location has saved no ETA at all. */
const DEFAULT_LEAD_MINUTES = 20;

export interface LocationSchedule {
  tz: string;
  hours: OpenInterval[];
  holidays: HolidayInterval[];
  /** Open now, when it opens next, when it closes. */
  state: OpenState;
  /** take_orders | announce. */
  closedBehavior: string;
  policy: SchedulePolicy;
  /** Today's hours as they would be said out loud, or null if shut all day. */
  hoursToday: string | null;
}

export async function loadLocationSchedule(locationId: string, now = new Date()): Promise<LocationSchedule | null> {
  const loc = await prisma.location.findUnique({
    where: { id: locationId },
    select: {
      timezone: true,
      pickupEnabled: true,
      deliveryEnabled: true,
      pickupEtaMinutes: true,
      deliveryEtaMinutes: true,
      hours: { select: { dayOfWeek: true, opensAt: true, closesAt: true } },
      aiSettings: {
        select: { closedBehavior: true, scheduleOrdersEnabled: true, scheduleMaxDaysAhead: true },
      },
    },
  });
  if (!loc) return null;
  const tz = loc.timezone ?? 'UTC';
  const today = localParts(now, tz).date;
  const holidayRows = await prisma.locationHolidayHours.findMany({
    where: {
      locationId,
      date: {
        gte: new Date(`${addLocalDays(today, -1)}T00:00:00.000Z`),
        lte: new Date(`${addLocalDays(today, HOLIDAY_WINDOW_DAYS)}T00:00:00.000Z`),
      },
    },
    select: { date: true, closed: true, opensAt: true, closesAt: true },
  });
  const holidays: HolidayInterval[] = holidayRows.map((h) => ({
    date: h.date.toISOString().slice(0, 10),
    closed: h.closed,
    opensAt: h.opensAt,
    closesAt: h.closesAt,
  }));
  const hours: OpenInterval[] = loc.hours;
  // The kitchen's own wait is the floor on any promise. Pickup is the one to
  // measure by where it is offered: it is the shorter, and a delivery order
  // scheduled for then still leaves the driver's time after it.
  const leadMinutes =
    (loc.pickupEnabled ? loc.pickupEtaMinutes : loc.deliveryEtaMinutes) ??
    loc.pickupEtaMinutes ??
    loc.deliveryEtaMinutes ??
    DEFAULT_LEAD_MINUTES;
  return {
    tz,
    hours,
    holidays,
    state: openStateAt(now, tz, hours, holidays),
    closedBehavior: loc.aiSettings?.closedBehavior ?? 'take_orders',
    policy: {
      enabled: loc.aiSettings?.scheduleOrdersEnabled ?? false,
      maxDaysAhead: loc.aiSettings?.scheduleMaxDaysAhead ?? 1,
      leadMinutes,
    },
    hoursToday: spokenHoursOn(today, tz, hours, holidays),
  };
}

/**
 * Should this call be answered as if the restaurant were open? Only an owner
 * who asked for the announcement gets it, and only where hours are actually
 * saved — a location that never entered any is not silently shut.
 */
export function announcesClosed(schedule: LocationSchedule): boolean {
  return schedule.closedBehavior === 'announce' && schedule.state.known && !schedule.state.open;
}
