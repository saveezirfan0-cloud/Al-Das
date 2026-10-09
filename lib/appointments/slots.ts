/**
 * Slot engine (pure, timezone-aware).
 *
 * Working hours are wall-clock minutes in the location's timezone, so "09:00" stays 09:00 across a
 * DST change. Everything else is absolute instants. Appointments (portal and Unite alike) and time
 * blocks occupy time; nothing here touches the database.
 */
import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export type WorkingHoursRow = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  start_min: number;
  end_min: number;
};

export type BusyInterval = { start: Date; end: Date };

export type Slot = {
  start: Date;
  end: Date;
  /** "HH:mm" in the location timezone, for the slot list. */
  label: string;
};

export type SlotInput = {
  /** Local calendar date in the location timezone: "YYYY-MM-DD". */
  date: string;
  timezone: string;
  durationMin: number;
  granularityMin: number;
  /** Rows for this specialist at this location (any weekday; the engine filters). */
  workingHours: readonly WorkingHoursRow[];
  /** Existing appointments (not cancelled) and time blocks. */
  busy: readonly BusyInterval[];
  now: Date;
  leadTimeMin: number;
  /** ISO weekdays the clinic is open. Default Mon–Sat (OQ-07). */
  workingWeekdays?: readonly number[];
  /** "YYYY-MM-DD" dates the clinic is closed. */
  holidays?: readonly string[];
};

const MIN_MS = 60_000;

/** ISO weekday (1–7) of a YYYY-MM-DD calendar date. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

/** Local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export function localDate(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, timezone, "yyyy-MM-dd");
}

/** Instant for "minutes after local midnight" on a local date. 1440 = next midnight. */
export function localMinutesToInstant(date: string, minutes: number, timezone: string): Date {
  if (minutes >= 1440) {
    const next = format(addDays(parseISO(`${date}T00:00:00`), 1), "yyyy-MM-dd");
    return fromZonedTime(`${next}T00:00:00`, timezone);
  }
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return fromZonedTime(`${date}T${hh}:${mm}:00`, timezone);
}

export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}

/** True when the clinic is open on this local date (working week and holidays). */
export function isOpenDay(
  date: string,
  workingWeekdays: readonly number[] = [1, 2, 3, 4, 5, 6],
  holidays: readonly string[] = [],
): boolean {
  return workingWeekdays.includes(isoWeekday(date)) && !holidays.includes(date);
}

/** Bookable slots for one specialist at one location on one local date, ordered by start. */
export function generateSlots(input: SlotInput): Slot[] {
  const { date, timezone, durationMin, granularityMin } = input;
  if (durationMin <= 0 || granularityMin <= 0) return [];
  if (!isOpenDay(date, input.workingWeekdays, input.holidays)) return [];

  const weekday = isoWeekday(date);
  const earliest = input.now.getTime() + input.leadTimeMin * MIN_MS;
  const stepMs = granularityMin * MIN_MS;
  const durationMs = durationMin * MIN_MS;
  const seen = new Set<number>();
  const slots: Slot[] = [];

  for (const row of input.workingHours) {
    if (row.weekday !== weekday || row.end_min <= row.start_min) continue;
    const windowStart = localMinutesToInstant(date, row.start_min, timezone).getTime();
    const windowEnd = localMinutesToInstant(date, row.end_min, timezone).getTime();
    for (let t = windowStart; t + durationMs <= windowEnd; t += stepMs) {
      if (t < earliest || seen.has(t)) continue;
      const start = new Date(t);
      const end = new Date(t + durationMs);
      if (input.busy.some((b) => overlaps(start, end, b.start, b.end))) continue;
      seen.add(t);
      slots.push({ start, end, label: formatInTimeZone(start, timezone, "HH:mm") });
    }
  }
  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/** Server-side re-check of a chosen start time against the generated slots. */
export function isSlotAvailable(input: SlotInput, start: Date): boolean {
  return generateSlots(input).some((s) => s.start.getTime() === start.getTime());
}

/** Working-hours windows for a local date as instants (used to shade the resource grid). */
export function workingWindows(
  date: string,
  timezone: string,
  workingHours: readonly WorkingHoursRow[],
  workingWeekdays?: readonly number[],
  holidays?: readonly string[],
): Array<{ start: Date; end: Date }> {
  if (!isOpenDay(date, workingWeekdays, holidays)) return [];
  const weekday = isoWeekday(date);
  return workingHours
    .filter((r) => r.weekday === weekday && r.end_min > r.start_min)
    .map((r) => ({
      start: localMinutesToInstant(date, r.start_min, timezone),
      end: localMinutesToInstant(date, r.end_min, timezone),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}
