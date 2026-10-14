/**
 * Recurring tasks (Phase F). Pure: the one rule for the next due time of a series. public.task_spawn_next() takes the
 * value computed here and is idempotent on it (one task per series and due time).
 *
 * The next occurrence keeps the wall-clock time in the organisation's timezone (a 09:00 task stays at 09:00).
 * Monthly keeps the day of the month, and a day the next month does not have becomes its last day (31 Jan, 28 Feb).
 */
import { addDays, addMonths, addWeeks } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import type { TaskRecurrence } from "@/lib/tasks/status";

function add(local: Date, recurrence: TaskRecurrence, n: number): Date {
  switch (recurrence) {
    case "daily":
      return addDays(local, n);
    case "weekly":
      return addWeeks(local, n);
    case "monthly":
      return addMonths(local, n);
  }
}

/**
 * The first occurrence after `dueAt` that is also after `notBefore` (so a series that fell behind, for example a daily
 * task nobody opened for a week, continues from today rather than creating every missed day). At most 400 steps.
 */
export function nextOccurrence(
  dueAt: Date,
  recurrence: TaskRecurrence,
  timezone: string,
  notBefore?: Date,
): Date {
  // Work in the local wall clock as a "UTC" date, then convert back, so DST changes keep the local time.
  const localWall = new Date(`${formatInTimeZone(dueAt, timezone, "yyyy-MM-dd'T'HH:mm:ss")}Z`);
  const floor = Math.max(dueAt.getTime(), notBefore?.getTime() ?? 0);
  for (let n = 1; n <= 400; n++) {
    const wall = add(localWall, recurrence, n);
    const next = fromZonedTime(wall.toISOString().slice(0, 19), timezone);
    if (next.getTime() > floor) return next;
  }
  return fromZonedTime(add(localWall, recurrence, 400).toISOString().slice(0, 19), timezone);
}

/** Dedupe key of the scheduled "make the next one" job for a task at a due time. */
export function recurrenceDedupeKey(taskId: string, dueAt: Date): string {
  return `task_recur:${taskId}:${dueAt.getTime()}`;
}
