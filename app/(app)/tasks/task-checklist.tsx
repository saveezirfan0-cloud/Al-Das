"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TASK_TYPE_LABELS } from "@/lib/tasks/due";
import type { TaskRow } from "@/lib/tasks/types";

import { createTaskAction, setTaskDoneAction } from "./actions";
import { DueBadge } from "./due-badge";
import { draftToInput, emptyDraft, TaskFields, type TaskDraft } from "./task-form";

/** Open tasks of one record with a checkbox to complete them and a quick "add task" form. */
export function TaskChecklist({
  tasks,
  link,
  users,
  timezone,
  canManage,
  onChanged,
}: {
  tasks: TaskRow[];
  link: { enquiry_id: string; contact_id: string | null };
  users: Array<{ id: string; label: string }>;
  timezone: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft());
  const [pending, start] = useTransition();

  function add() {
    if (!draft.subject.trim()) {
      toast.error("Give the task a subject.");
      return;
    }
    start(async () => {
      const r = await createTaskAction({
        ...draftToInput(draft, timezone),
        enquiry_id: link.enquiry_id,
        contact_id: link.contact_id,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success("Task added.");
      setAdding(false);
      setDraft(emptyDraft());
      onChanged();
    });
  }

  function complete(id: string) {
    start(async () => {
      const r = await setTaskDoneAction(id, true);
      if (!r.ok) toast.error(r.error);
      else onChanged();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {tasks.length === 0 && <p className="text-muted-foreground text-sm">No open tasks.</p>}
      <ul className="flex flex-col gap-2">
        {tasks.map((t) => (
          <li key={t.id} className="flex items-start gap-3 rounded-md border p-2.5">
            <Checkbox
              aria-label={`Mark "${t.subject}" done`}
              disabled={!canManage || pending}
              onCheckedChange={() => complete(t.id)}
              className="mt-0.5"
            />
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-medium">{t.subject}</div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span>{TASK_TYPE_LABELS[t.type]}</span>
                {t.assignee_name && <span>{t.assignee_name}</span>}
                <DueBadge task={t} timezone={timezone} />
              </div>
            </div>
          </li>
        ))}
      </ul>
      {canManage &&
        (adding ? (
          <div className="flex flex-col gap-3 rounded-md border p-3">
            <TaskFields
              draft={draft}
              onChange={setDraft}
              users={users}
              timezone={timezone}
              lockLinks
              canSearchPatients={false}
              canLookUpEnquiries={false}
              compact
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={add} disabled={pending}>
                Add task
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => setAdding(true)}
          >
            <Plus /> Add task
          </Button>
        ))}
    </div>
  );
}
