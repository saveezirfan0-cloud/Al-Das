/** Task types and due-date classification. Pure. */
export const TASK_TYPES = ["todo", "call", "follow_up", "meeting", "email", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  todo: "To-do",
  call: "Call",
  follow_up: "Follow-up",
  meeting: "Meeting",
  email: "Email",
  other: "Other",
};

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}

export type DueState = "done" | "overdue" | "today" | "upcoming" | "none";

/** Same-calendar-day test in a given IANA timezone (the org's), so "today" matches the clinic's day. */
function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function classifyDue(
  task: { done: boolean; due_at: string | null },
  now: Date = new Date(),
  timeZone = "Asia/Dubai",
): DueState {
  if (task.done) return "done";
  if (!task.due_at) return "none";
  const due = new Date(task.due_at);
  if (Number.isNaN(due.getTime())) return "none";
  if (due.getTime() < now.getTime())
    return dayKey(due, timeZone) === dayKey(now, timeZone) ? "today" : "overdue";
  return dayKey(due, timeZone) === dayKey(now, timeZone) ? "today" : "upcoming";
}

/** Due moment reached, task open and assigned, and nobody has been told yet. */
export function needsDueNotice(
  task: {
    done: boolean;
    due_at: string | null;
    assignee_id: string | null;
    due_notified_at: string | null;
  },
  now: Date = new Date(),
): boolean {
  if (task.done || !task.due_at || !task.assignee_id || task.due_notified_at) return false;
  const due = new Date(task.due_at).getTime();
  return !Number.isNaN(due) && due <= now.getTime();
}
