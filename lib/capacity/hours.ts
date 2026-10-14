/**
 * Capacity hours (M3, docs/23_PHASE_M3A_NOTES.md). Pure: no database, no clock.
 *
 * A doctor's available hours in a month are their working-hours windows on the clinic's open days, minus weekly blocks
 * (lunch, admin) and one-off time blocks (leave, training). The windows, the open-day rule (working week and holidays)
 * and the weekly-block expansion come from the slot engine (lib/appointments/slots.ts), so "available" here means
 * exactly the time the booking drawer would offer before any appointment is booked. Nothing here changes booking.
 *
 * A room's rota hours are its weekly rota rows (wall-clock minutes, like working hours) counted on each open day.
 */
import {
  expandRecurringBlocks,
  isOpenDay,
  isoWeekday,
  shiftLocalDate,
  workingWindows,
  type RecurringBlockRow,
  type WorkingHoursRow,
} from "@/lib/appointments/slots";

export type Interval = { start: number; end: number };

/** Every local date (YYYY-MM-DD) of the month that starts on `month` (YYYY-MM-01). */
export function monthDates(month: string): string[] {
  const m = /^(\d{4})-(\d{2})-01$/.exec(month);
  if (!m) return [];
  const days = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return Array.from(
    { length: days },
    (_, i) => `${m[1]}-${m[2]}-${String(i + 1).padStart(2, "0")}`,
  );
}

/** The month's dates the clinic is open (working week, minus holidays): the slot engine's own rule. */
export function openDates(
  month: string,
  workingWeekdays?: readonly number[],
  holidays?: readonly string[],
): string[] {
  return monthDates(month).filter((d) => isOpenDay(d, workingWeekdays, holidays));
}

/** Overlapping or touching intervals merged, sorted by start. Empty intervals are dropped. */
export function unionIntervals(list: readonly Interval[]): Interval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push({ ...i });
  }
  return out;
}

/** `windows` with every part covered by `blocks` cut out. */
export function subtractIntervals(
  windows: readonly Interval[],
  blocks: readonly Interval[],
): Interval[] {
  const cuts = unionIntervals(blocks);
  const out: Interval[] = [];
  for (const w of unionIntervals(windows)) {
    let start = w.start;
    for (const b of cuts) {
      if (b.end <= start || b.start >= w.end) continue;
      if (b.start > start) out.push({ start, end: b.start });
      start = Math.max(start, b.end);
      if (start >= w.end) break;
    }
    if (start < w.end) out.push({ start, end: w.end });
  }
  return out;
}

export const minutesOf = (list: readonly Interval[]): number =>
  list.reduce((s, i) => s + (i.end - i.start), 0) / 60_000;

/** One branch where the doctor works: their rows there, in that branch's timezone. */
export type DoctorLocationHours = {
  timezone: string;
  workingHours: readonly WorkingHoursRow[];
  /** Weekly blocks that apply here (location null or this location). */
  recurringBlocks: readonly RecurringBlockRow[];
  /** One-off blocks that apply here (location null or this location), as instants. */
  timeBlocks: readonly { start: Date; end: Date }[];
};

export type AvailableHoursInput = {
  /** YYYY-MM-01. */
  month: string;
  workingWeekdays?: readonly number[];
  holidays?: readonly string[];
  locations: readonly DoctorLocationHours[];
};

/**
 * A doctor's available minutes in the month. Per branch: working windows on open days, minus that branch's weekly and
 * one-off blocks. Across branches the remaining time is merged, so two branches' rows at the same moment count once.
 */
export function availableMinutes(input: AvailableHoursInput): number {
  const free: Interval[] = [];
  const dates = monthDates(input.month);
  for (const loc of input.locations) {
    const oneOff = loc.timeBlocks.map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }));
    for (const date of dates) {
      const windows = workingWindows(
        date,
        loc.timezone,
        loc.workingHours,
        input.workingWeekdays,
        input.holidays,
      ).map((w) => ({ start: w.start.getTime(), end: w.end.getTime() }));
      if (windows.length === 0) continue;
      const weekly = expandRecurringBlocks(loc.recurringBlocks, date, date, loc.timezone).map(
        (b) => ({ start: b.start.getTime(), end: b.end.getTime() }),
      );
      free.push(...subtractIntervals(windows, [...weekly, ...oneOff]));
    }
  }
  return minutesOf(unionIntervals(free));
}

/** The instants a month's one-off blocks must overlap to matter, with a day's margin for any timezone. */
export function monthRange(month: string): { from: string; to: string } {
  const dates = monthDates(month);
  if (dates.length === 0) return { from: month, to: month };
  return {
    from: `${shiftLocalDate(dates[0], -1)}T00:00:00Z`,
    to: `${shiftLocalDate(dates[dates.length - 1], 2)}T00:00:00Z`,
  };
}

export type RotaRow = {
  room_id: string;
  specialist_id: string;
  weekday: number;
  start_min: number;
  end_min: number;
};

/** Minutes per (room, doctor) in the month: each weekly row counted on every open date with its weekday. */
export function rotaMinutes(
  rows: readonly RotaRow[],
  open: readonly string[],
): Map<string, Map<string, number>> {
  const perWeekday = new Map<number, number>();
  for (const d of open) perWeekday.set(isoWeekday(d), (perWeekday.get(isoWeekday(d)) ?? 0) + 1);
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    const days = perWeekday.get(r.weekday) ?? 0;
    const mins = Math.max(0, r.end_min - r.start_min) * days;
    if (mins === 0) continue;
    const room = out.get(r.room_id) ?? new Map<string, number>();
    room.set(r.specialist_id, (room.get(r.specialist_id) ?? 0) + mins);
    out.set(r.room_id, room);
  }
  return out;
}
