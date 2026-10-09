import { Badge } from "@/components/ui/badge";
import { classifyDue } from "@/lib/tasks/due";

import { formatWhen } from "../enquiries/format";

/** Due date with a colour for overdue / today. */
export function DueBadge({
  task,
  timezone,
}: {
  task: { done: boolean; due_at: string | null };
  timezone: string;
}) {
  const state = classifyDue(task, new Date(), timezone);
  if (state === "none") return <span className="text-muted-foreground text-xs">No due date</span>;
  const text = formatWhen(task.due_at, timezone);
  if (state === "done") return <span className="text-muted-foreground text-xs">{text}</span>;
  if (state === "overdue") return <Badge variant="destructive">{text}</Badge>;
  if (state === "today") return <Badge variant="warning">{text}</Badge>;
  return <span className="text-xs">{text}</span>;
}
