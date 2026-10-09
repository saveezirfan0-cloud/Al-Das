"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { TaskRow } from "@/lib/tasks/types";

import { createTaskAction, deleteTaskAction, setTaskDoneAction, updateTaskAction } from "./actions";
import { draftFromTask, draftToInput, emptyDraft, TaskFields, type TaskDraft } from "./task-form";

/** Right-side drawer to create or edit a task. `task = null` creates. */
export function TaskDrawer({
  open,
  task,
  users,
  timezone,
  preset,
  canSearchPatients,
  canLookUpEnquiries,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  task: TaskRow | null;
  users: Array<{ id: string; label: string }>;
  timezone: string;
  preset?: Partial<TaskDraft>;
  canSearchPatients: boolean;
  canLookUpEnquiries: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(emptyDraft());
  const [pending, start] = useTransition();

  useEffect(() => {
    if (open) setDraft(task ? draftFromTask(task, timezone) : emptyDraft(preset));
  }, [open, task, timezone, preset]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done: string, close = true) {
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? "Something went wrong.");
        return;
      }
      toast.success(done);
      onSaved();
      if (close) onOpenChange(false);
    });
  }

  function save() {
    if (!draft.subject.trim()) {
      toast.error("Give the task a subject.");
      return;
    }
    const input = draftToInput(draft, timezone);
    run(
      () =>
        task
          ? updateTaskAction(task.id, input)
          : createTaskAction({ ...input, subject: input.subject }),
      task ? "Task saved." : "Task created.",
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{task ? "Edit task" : "New task"}</SheetTitle>
          <SheetDescription>
            {task
              ? `Created ${task.created_by_name ? `by ${task.created_by_name}` : ""}`
              : "Assign a follow-up with a due time so nothing slips."}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <TaskFields
            draft={draft}
            onChange={setDraft}
            users={users}
            timezone={timezone}
            canSearchPatients={canSearchPatients}
            canLookUpEnquiries={canLookUpEnquiries}
          />
        </div>
        <SheetFooter className="flex-row flex-wrap justify-between border-t">
          <div className="flex gap-2">
            {task && (
              <>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    run(
                      () => setTaskDoneAction(task.id, !task.done),
                      task.done ? "Reopened." : "Marked done.",
                    )
                  }
                >
                  <Check /> {task.done ? "Reopen" : "Mark done"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending}
                  onClick={() => {
                    if (confirm("Delete this task?"))
                      run(() => deleteTaskAction(task.id), "Task deleted.");
                  }}
                >
                  <Trash2 /> Delete
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={save} disabled={pending}>
              {pending && <Loader2 className="animate-spin" />} Save
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
