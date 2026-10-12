import { addDays } from "@/lib/reports/range";
import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

/** Snooze choices in the notification centre. Pure: callers pass `now` and the timezone. */
export type SnoozePreset = "1h" | "3h" | "tomorrow" | "next_week";

export const SNOOZE_LABELS: Record<SnoozePreset, string> = {
  "1h": "1 hour",
  "3h": "3 hours",
  tomorrow: "Tomorrow morning",
  next_week: "Next Monday",
};

export const SNOOZE_PRESETS = Object.keys(SNOOZE_LABELS) as SnoozePreset[];

/** Morning hour used for "tomorrow" and "next Monday" (local time). */
export const SNOOZE_MORNING_HOUR = 8;

export function isSnoozePreset(value: string): value is SnoozePreset {
  return (SNOOZE_PRESETS as string[]).includes(value);
}

export function snoozeUntil(preset: SnoozePreset, now: Date, timezone: string): Date {
  if (preset === "1h") return new Date(now.getTime() + 3_600_000);
  if (preset === "3h") return new Date(now.getTime() + 3 * 3_600_000);
  const today = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  const hh = String(SNOOZE_MORNING_HOUR).padStart(2, "0");
  if (preset === "tomorrow") return fromZonedTime(`${addDays(today, 1)}T${hh}:00:00`, timezone);
  const isoWeekday = Number(formatInTimeZone(now, timezone, "i")); // Monday = 1
  const daysToMonday = isoWeekday === 1 ? 7 : 8 - isoWeekday;
  return fromZonedTime(`${addDays(today, daysToMonday)}T${hh}:00:00`, timezone);
}

/** A notification is visible (counts towards unread) unless it is snoozed into the future. */
export function isSnoozed(
  snoozedUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return !!snoozedUntil && new Date(snoozedUntil).getTime() > now.getTime();
}
