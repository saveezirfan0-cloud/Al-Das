export const TASK_TYPES = ["call", "follow_up", "email", "meeting", "other"] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  call: "Call",
  follow_up: "Follow-up",
  email: "Email",
  meeting: "Meeting",
  other: "Other",
};
