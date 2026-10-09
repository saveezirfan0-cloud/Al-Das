import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

export const TASK_STATES = ["open", "overdue", "today", "done", "all"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type TaskRange = {
  /** Filter on the `done` flag; undefined = either. */
  done?: boolean;
  /** due_at < dueBefore */
  dueBefore?: Date;
  /** dueFrom <= due_at < dueTo */
  dueFrom?: Date;
  dueTo?: Date;
};

/** Start of the org-local day containing `now`, as an instant. */
export function startOfLocalDay(now: Date, timezone: string): Date {
  const day = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  return fromZonedTime(`${day}T00:00:00`, timezone);
}

/**
 * The due-date constraints behind each Tasks filter. "Today" is the org-local calendar day
 * (not UTC), and overdue means open and past its due time.
 */
export function taskStateRange(state: TaskState, now: Date, timezone: string): TaskRange {
  switch (state) {
    case "open":
      return { done: false };
    case "done":
      return { done: true };
    case "overdue":
      return { done: false, dueBefore: now };
    case "today": {
      const from = startOfLocalDay(now, timezone);
      // 25h after local midnight, re-snapped, so DST days (23h/25h) still end at the next midnight.
      const next = startOfLocalDay(new Date(from.getTime() + 36 * 3600_000), timezone);
      return { done: false, dueFrom: from, dueTo: next };
    }
    case "all":
      return {};
  }
}
