import { formatInTimeZone } from "date-fns-tz";

import type { Weekday } from "@/lib/flow-engine/types";

export type OfficeSchedule = Partial<Record<Weekday, Array<{ from: string; to: string }>>>;

const DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * True when `at` falls inside one of the day's windows in `timezone`. A window whose end is
 * before its start runs past midnight (22:00–02:00); the part after midnight belongs to the
 * next calendar day's check against the previous day's window.
 */
export function isOfficeOpen(schedule: OfficeSchedule, at: Date, timezone: string): boolean {
  const iso = Number(formatInTimeZone(at, timezone, "i")); // 1..7
  const today = DAYS[iso - 1];
  const yesterday = DAYS[(iso + 5) % 7];
  const minutes =
    Number(formatInTimeZone(at, timezone, "H")) * 60 + Number(formatInTimeZone(at, timezone, "m"));
  for (const w of schedule[today] ?? []) {
    const from = toMin(w.from);
    const to = toMin(w.to);
    if (to > from ? minutes >= from && minutes < to : minutes >= from) return true;
  }
  for (const w of schedule[yesterday] ?? []) {
    const from = toMin(w.from);
    const to = toMin(w.to);
    if (to <= from && minutes < to) return true;
  }
  return false;
}
