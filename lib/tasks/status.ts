/** Tasks v2 status and priority (pure). The database keeps status and the old `done` flag in step (tasks_status_sync). */

export const TASK_STATUSES = ["todo", "in_progress", "blocked", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

export const TASK_RECURRENCES = ["daily", "weekly", "monthly"] as const;
export type TaskRecurrence = (typeof TASK_RECURRENCES)[number];

export const TASK_RECURRENCE_LABELS: Record<TaskRecurrence, string> = {
  daily: "Every day",
  weekly: "Every week",
  monthly: "Every month",
};

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (TASK_STATUSES as readonly string[]).includes(v);
}

/**
 * Mirror of app.tasks_status_sync for an update: what status and done end up as when a patch changes either.
 * Changing status wins over done; leaving "done" reopens the task; a done flag alone moves status to done / to do.
 */
export function syncStatus(
  before: { status: TaskStatus; done: boolean },
  patch: { status?: TaskStatus; done?: boolean },
): { status: TaskStatus; done: boolean } {
  if (patch.status !== undefined && patch.status !== before.status) {
    if (patch.status === "done") return { status: "done", done: true };
    return { status: patch.status, done: false };
  }
  if (patch.done !== undefined && patch.done !== before.done)
    return { status: patch.done ? "done" : "todo", done: patch.done };
  return { status: before.status, done: before.done };
}

/** Board order: open work first by priority, then due time. */
export const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export function compareForBoard(
  a: { priority: string; due_at: string },
  b: { priority: string; due_at: string },
): number {
  const pa = PRIORITY_RANK[a.priority as TaskPriority] ?? 2;
  const pb = PRIORITY_RANK[b.priority as TaskPriority] ?? 2;
  if (pa !== pb) return pa - pb;
  return new Date(a.due_at).getTime() - new Date(b.due_at).getTime();
}
