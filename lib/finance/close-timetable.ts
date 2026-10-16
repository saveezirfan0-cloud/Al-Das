import { addDays, dayNumber } from "@/lib/documents/expiry";

/**
 * Phase 20G: the monthly close timetable (pure; unit-tested). Dates are calendar dates (YYYY-MM-DD) in the clinic's
 * timezone. A close month is the month being closed (its first day, as in fin_period_closes); its working days are
 * counted in the month AFTER it: September's WD5 is the fifth working day of October.
 *
 * Weekend days use ISO numbers: 1 = Monday .. 7 = Sunday (UAE default: Saturday and Sunday, [6, 7]).
 */

export type WorkCalendar = {
  weekend: readonly number[];
  holidays: readonly string[];
};

export type TaskStatus = "open" | "done" | "blocked";

export const STEP_CODE_RE = /^[A-Z0-9_]{1,24}$/;
export const MAX_DUE_WD = 23;
/** A calendar deadline day is 1 to 28, so it exists in every month. */
export const MAX_DEADLINE_DAY = 28;
export const DEFAULT_WEEKEND: readonly number[] = [6, 7];
export const WEEKDAY_LABELS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
  7: "Sunday",
};

/** ISO weekday (1 = Monday .. 7 = Sunday), or null for a date that does not exist. */
export function isoWeekday(date: string): number | null {
  const n = dayNumber(date);
  if (n === null) return null;
  // day 0 (1970-01-01) was a Thursday (4)
  return ((((n + 3) % 7) + 7) % 7) + 1;
}

export function isWorkingDay(date: string, cal: WorkCalendar): boolean {
  const wd = isoWeekday(date);
  if (wd === null) return false;
  return !cal.weekend.includes(wd) && !cal.holidays.includes(date);
}

/** The first day of the month a YYYY-MM or YYYY-MM-DD string falls in, or null. */
export function monthStart(value: string): string | null {
  const first = `${value.slice(0, 7)}-01`;
  return dayNumber(first) === null ? null : first;
}

/** First day of the month `n` months after (or before, n < 0) the month of `month`. */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
}

/**
 * The n-th working day counted from the 1st of `month` (YYYY-MM or YYYY-MM-DD). Counting continues into the next month
 * when the month has fewer than n working days. Null for n outside 1..23, an invalid month, or a calendar with no
 * working day at all.
 */
export function workingDay(month: string, n: number, cal: WorkCalendar): string | null {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DUE_WD) return null;
  let day = monthStart(month);
  if (!day) return null;
  let seen = 0;
  for (let i = 0; i < 400 && day; i++) {
    if (isWorkingDay(day, cal)) {
      seen++;
      if (seen === n) return day;
    }
    day = addDays(day, 1);
  }
  return null;
}

/** How many working days of its month have passed up to and including `date` (0 before the first working day). */
export function workingDayOf(date: string, cal: WorkCalendar): number {
  let day = monthStart(date);
  if (!day || dayNumber(date) === null) return 0;
  let count = 0;
  while (day && day <= date) {
    if (isWorkingDay(day, cal)) count++;
    day = addDays(day, 1);
  }
  return count;
}

/** The close month being worked on `today`: the month before (September's close runs in October). */
export function closeMonthFor(today: string): string {
  return addMonths(today, -1);
}

/** How many close months before the current one still get reminders while they are not locked. */
export const REMINDER_EARLIER_MONTHS = 2;

/**
 * The close months whose open steps are reminded on `today`: the current close month and the two before it (a late step
 * of September's close, say working day 23 on 2 November, still matters while September is not locked), never one
 * before the timetable's start month. The caller drops the locked ones; the claim in the database refuses them too.
 */
export function reminderMonths(today: string, startMonth: string): string[] {
  const current = closeMonthFor(today);
  return Array.from({ length: REMINDER_EARLIER_MONTHS + 1 }, (_, i) =>
    addMonths(current, -i),
  ).filter((m) => m >= startMonth);
}

/** Due date of a step due on working day `wd` for close month `closeMonth`. */
export function dueOn(closeMonth: string, wd: number, cal: WorkCalendar): string | null {
  return workingDay(addMonths(closeMonth, 1), wd, cal);
}

/** Whether an unfinished step is due today or late. A done step, or one with no due date, is neither. */
export function lateness(
  status: TaskStatus,
  due: string | null,
  today: string,
): "none" | "due_today" | "overdue" {
  if (status === "done" || !due) return "none";
  if (today > due) return "overdue";
  return today === due ? "due_today" : "none";
}

/** Ids of the tasks whose reminder is due today: not done, due today or earlier. */
export function tasksToRemind(
  tasks: readonly { id: string; status: TaskStatus; dueOn: string | null }[],
  today: string,
): string[] {
  return tasks
    .filter((t) => t.status !== "done" && t.dueOn !== null && t.dueOn <= today)
    .map((t) => t.id);
}

/**
 * One reminder per person: claimed tasks grouped by owner. A step with no owner goes to `fallback` (the people who
 * manage the close), so an unassigned step is never silently forgotten.
 */
export function remindersByRecipient(
  claimed: readonly { task_id: string; owner_user_id: string | null }[],
  fallback: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of claimed) {
    const to = c.owner_user_id ? [c.owner_user_id] : fallback;
    for (const u of new Set(to)) out.set(u, (out.get(u) ?? 0) + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Measures (deck slide 11)
// ---------------------------------------------------------------------------------------------------------------------

export type KpiTask = {
  status: TaskStatus;
  dueWd: number;
  dueOn: string | null;
  /** The day it was marked done, in the clinic's timezone. */
  doneOn: string | null;
};

export type InputsMeasure = {
  total: number;
  onTime: number;
  late: number;
  pending: number;
  /** onTime / (onTime + late); null while nothing can be judged yet. */
  rate: number | null;
};

/**
 * Departmental inputs on time: the steps due on or before working day `inputsWd`. On time = marked done on or before
 * its due date. Late = done after it, or still not done after it. Pending = not done and not yet due. A task with no
 * due date fails closed (late).
 */
export function inputsOnTime(
  tasks: readonly KpiTask[],
  inputsWd: number,
  today: string,
): InputsMeasure {
  const m: InputsMeasure = { total: 0, onTime: 0, late: 0, pending: 0, rate: null };
  for (const t of tasks) {
    if (t.dueWd > inputsWd) continue;
    m.total++;
    if (!t.dueOn) m.late++;
    else if (t.status === "done" && t.doneOn) {
      if (t.doneOn <= t.dueOn) m.onTime++;
      else m.late++;
    } else if (today > t.dueOn) m.late++;
    else m.pending++;
  }
  const judged = m.onTime + m.late;
  m.rate = judged > 0 ? m.onTime / judged : null;
  return m;
}

export type Delivery = "on_time" | "late" | "missed" | "open";

/**
 * Close delivered by the deadline working day: the CEO sign-off (lock) on or before the deadline. "missed" = the
 * deadline passed without a lock; "open" = not locked and the deadline has not passed (or cannot be worked out).
 */
export function closeDelivery(
  lockedOn: string | null,
  deadline: string | null,
  today: string,
): Delivery {
  if (!deadline) return "open";
  if (lockedOn) return lockedOn <= deadline ? "on_time" : "late";
  return today > deadline ? "missed" : "open";
}

export type BackupMeasure = {
  total: number;
  covered: number;
  missing: string[];
  rate: number | null;
};

/** Single-person dependency: active steps that have a backup who is not the owner. */
export function backupCoverage(
  steps: readonly {
    code: string;
    active: boolean;
    ownerUserId: string | null;
    backupUserId: string | null;
  }[],
): BackupMeasure {
  const active = steps.filter((s) => s.active);
  const missing = active
    .filter((s) => !s.backupUserId || s.backupUserId === s.ownerUserId)
    .map((s) => s.code);
  return {
    total: active.length,
    covered: active.length - missing.length,
    missing,
    rate: active.length > 0 ? (active.length - missing.length) / active.length : null,
  };
}

/** Whole days between an item's opening day and today (0 on the day), null without a date. */
export function ageDays(openedOn: string | null, today: string): number | null {
  const a = dayNumber(openedOn);
  const b = dayNumber(today);
  return a === null || b === null ? null : Math.max(0, b - a);
}

/**
 * The close deadline for a close month. When `deadlineDay` is set (management's rule of 16 Oct 2026: "the reporting and
 * approval trail for the preceding month is complete by the 10th"), it is that calendar day of the month after the close
 * month, whatever the weekday; otherwise it is working day `deadlineWd` of that month.
 */
export function closeDeadlineOn(
  closeMonth: string,
  deadlineWd: number,
  deadlineDay: number | null,
  cal: WorkCalendar,
): string | null {
  if (deadlineDay === null) return dueOn(closeMonth, deadlineWd, cal);
  const first = monthStart(closeMonth);
  if (!first || !Number.isInteger(deadlineDay) || deadlineDay < 1 || deadlineDay > MAX_DEADLINE_DAY)
    return null;
  return `${addMonths(first, 1).slice(0, 8)}${String(deadlineDay).padStart(2, "0")}`;
}

/** "the 10th" for a calendar deadline, "WD10" for a working-day one. */
export function deadlineLabel(deadlineWd: number, deadlineDay: number | null): string {
  if (deadlineDay === null) return `WD${deadlineWd}`;
  const n = deadlineDay % 100;
  const suffix = n >= 11 && n <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `the ${deadlineDay}${suffix}`;
}

export type MonthKpi = {
  month: string;
  inputs: InputsMeasure;
  deadlineOn: string | null;
  lockedOn: string | null;
  delivery: Delivery;
};

/** One row per close month (newest first as given): inputs on time and delivery by the deadline working day. */
export function monthKpis(input: {
  months: readonly string[];
  tasks: readonly (KpiTask & { month: string })[];
  lockedOn: Readonly<Record<string, string | null>>;
  cal: WorkCalendar;
  inputsWd: number;
  deadlineWd: number;
  /** Calendar deadline day (1-28) of the following month; null = use deadlineWd. */
  deadlineDay?: number | null;
  today: string;
}): MonthKpi[] {
  return input.months.map((month) => {
    const deadlineOn = closeDeadlineOn(
      month,
      input.deadlineWd,
      input.deadlineDay ?? null,
      input.cal,
    );
    const lockedOn = input.lockedOn[month] ?? null;
    return {
      month,
      inputs: inputsOnTime(
        input.tasks.filter((t) => t.month === month),
        input.inputsWd,
        input.today,
      ),
      deadlineOn,
      lockedOn,
      delivery: closeDelivery(lockedOn, deadlineOn, input.today),
    };
  });
}
