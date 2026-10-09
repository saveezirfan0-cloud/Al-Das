/** Pure due-date helpers for tasks (framework-free; shared by server, client and tests). */

export type DueState = "done" | "overdue" | "today" | "upcoming";

/** "today" is judged in the caller's timezone via the two day-key strings. */
export function dueState(
  task: { done: boolean; due_at: string | Date },
  now: Date,
  dayKey: (d: Date) => string = (d) => d.toISOString().slice(0, 10),
): DueState {
  if (task.done) return "done";
  const due = new Date(task.due_at);
  if (due.getTime() < now.getTime()) return "overdue";
  return dayKey(due) === dayKey(now) ? "today" : "upcoming";
}

/**
 * When the due reminder should fire: `leadMinutes` before the due time, or null if
 * that moment has already passed (overdue tasks get no retroactive reminder).
 */
export function reminderRunAt(dueAt: Date, leadMinutes: number, now: Date): Date | null {
  const runAt = new Date(dueAt.getTime() - Math.max(0, leadMinutes) * 60_000);
  if (dueAt.getTime() <= now.getTime()) return null;
  return runAt.getTime() <= now.getTime() ? now : runAt;
}

/** Dedupe key: a new due time gets a new key, so a moved task is not blocked by its old pending job. */
export function reminderDedupeKey(taskId: string, dueAt: Date): string {
  return `task_due:${taskId}:${dueAt.getTime()}`;
}

/** Should a fired reminder still notify? The task must be open and still due at the scheduled time. */
export function reminderStillValid(
  task: { done: boolean; due_at: string | Date },
  scheduledDueAt: string | Date,
): boolean {
  return !task.done && new Date(task.due_at).getTime() === new Date(scheduledDueAt).getTime();
}
