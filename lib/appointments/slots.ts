/**
 * Slot engine (pure, timezone-aware). This is the ONE slot generator: the booking drawer, the front desk's
 * next free slots, the waiting-list offers and the server-side re-check all go through generateSlots /
 * slotFits (Phase 20c, G6; docs/25_PHASE_20C_BOOKING_NOTES.md).
 *
 * Working hours and recurring blocks are wall-clock minutes in the location's timezone, so "09:00" stays
 * 09:00 across a DST change. Everything else is absolute instants. Appointments (portal and Unite alike) and
 * time blocks occupy time; nothing here touches the database.
 *
 * Capacity rule (mirrored in SQL by app.slot_conflict, 20261110000400_booking_capacity.sql): every interval
 * is widened by its own buffers. A candidate fits when the number n of busy intervals whose widened interval
 * overlaps the candidate's widened interval is 0, or n < the smallest `capacity` among the candidate and
 * every overlapping interval. A time block (or a booking without a capacity) counts as capacity 1, so nothing
 * may overlap it. With every default (capacity 1, no buffers) any overlap refuses the slot, exactly as before.
 * Buffers keep bookings and blocks apart; they do not have to fit inside working hours.
 */
import { addDays, format, parseISO } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export type WorkingHoursRow = {
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
  start_min: number;
  end_min: number;
};

/** A weekly unavailable time (lunch, admin) in the location's wall clock; same shape as working hours. */
export type RecurringBlockRow = WorkingHoursRow;

export type BusyInterval = {
  start: Date;
  end: Date;
  /** The specialist is busy this long before / after (the booked service's buffers). Blocks have none. */
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  /**
   * Places this booking allows at once: least(service concurrent patients, specialist max per slot).
   * Absent = 1, which is also what a time block is: nothing may overlap it.
   */
  capacity?: number;
};

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
  /** Step of the slot list: the specialist's slot length, else the org's slot granularity. */
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
  /** The booked service's buffers in minutes. Default 0. */
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  /** least(service concurrent patients, specialist max per slot). Default 1. */
  capacity?: number;
  /** Weekly blocks for this specialist at this location (any weekday; the engine expands them). */
  recurringBlocks?: readonly RecurringBlockRow[];
};

export type SlotCandidate = {
  start: Date;
  end: Date;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  capacity?: number;
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

/** YYYY-MM-DD shifted by whole calendar days. */
export function shiftLocalDate(date: string, days: number): string {
  return format(addDays(parseISO(`${date}T00:00:00`), days), "yyyy-MM-dd");
}

/** Instant for "minutes after local midnight" on a local date. 1440 = next midnight. */
export function localMinutesToInstant(date: string, minutes: number, timezone: string): Date {
  if (minutes >= 1440) {
    return fromZonedTime(`${shiftLocalDate(date, 1)}T00:00:00`, timezone);
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

/** Weekly blocks as instants on every local date from `fromDate` to `toDate` (inclusive). */
export function expandRecurringBlocks(
  rows: readonly RecurringBlockRow[],
  fromDate: string,
  toDate: string,
  timezone: string,
): BusyInterval[] {
  const out: BusyInterval[] = [];
  if (rows.length === 0) return out;
  for (let d = fromDate, guard = 0; d <= toDate && guard < 62; d = shiftLocalDate(d, 1), guard++) {
    const weekday = isoWeekday(d);
    for (const r of rows) {
      if (r.weekday !== weekday || r.end_min <= r.start_min) continue;
      out.push({
        start: localMinutesToInstant(d, r.start_min, timezone),
        end: localMinutesToInstant(d, r.end_min, timezone),
      });
    }
  }
  return out;
}

const places = (n: number | undefined) => Math.max(1, Math.floor(n ?? 1));
const widen = (i: {
  start: Date;
  end: Date;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}) => ({
  start: i.start.getTime() - Math.max(0, i.bufferBeforeMin ?? 0) * MIN_MS,
  end: i.end.getTime() + Math.max(0, i.bufferAfterMin ?? 0) * MIN_MS,
});

/** The capacity rule for one candidate interval (see the file header). Mirrors app.slot_conflict. */
export function slotFits(candidate: SlotCandidate, busy: readonly BusyInterval[]): boolean {
  const c = widen(candidate);
  let n = 0;
  let limit = places(candidate.capacity);
  for (const b of busy) {
    const w = widen(b);
    if (w.start < c.end && w.end > c.start) {
      n++;
      limit = Math.min(limit, places(b.capacity));
      if (n >= limit) return false;
    }
  }
  return true;
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
  // Buffers can reach across midnight, so the neighbouring days' weekly blocks count too.
  const busy: BusyInterval[] = [
    ...input.busy,
    ...expandRecurringBlocks(
      input.recurringBlocks ?? [],
      shiftLocalDate(date, -1),
      shiftLocalDate(date, 1),
      timezone,
    ),
  ];
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
      const fits = slotFits(
        {
          start,
          end,
          bufferBeforeMin: input.bufferBeforeMin,
          bufferAfterMin: input.bufferAfterMin,
          capacity: input.capacity,
        },
        busy,
      );
      if (!fits) continue;
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
