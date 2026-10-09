"use client";

import * as React from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { createTaskAction, setTasksDoneAction } from "@/app/(app)/tasks/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { formatDateTime } from "@/lib/contacts/format";
import { fromLocalInput, toLocalInput } from "@/lib/enquiries/datetime";
import { TASK_TYPES, TASK_TYPE_LABELS, type TaskType } from "@/lib/tasks/constants";
import { dueState } from "@/lib/tasks/due";
import { cn } from "@/lib/utils";

import type { EnquiryDetail } from "./actions";
import { OptionSelect } from "./option-select";
import type { EnquiriesBootstrap } from "./types";

function nextHour(tz: string): string {
  return toLocalInput(
    new Date(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000).toISOString(),
    tz,
  );
}

/** The enquiry drawer's Tasks tab: this enquiry's tasks, tick them off, add a follow-up. */
export function EnquiryTasks({
  detail,
  bootstrap,
  reload,
}: {
  detail: EnquiryDetail;
  bootstrap: EnquiriesBootstrap;
  reload: () => Promise<void>;
}) {
  const [type, setType] = React.useState<TaskType>("follow_up");
  const [subject, setSubject] = React.useState("");
  const [due, setDue] = React.useState(() => nextHour(bootstrap.timezone));
  const [assignee, setAssignee] = React.useState<string | null>(bootstrap.userId);
  const [pending, startTransition] = React.useTransition();
  const userName = new Map(bootstrap.users.map((u) => [u.id, u.label]));
  const canManage = bootstrap.can.manage;

  function add(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createTaskAction({
        type,
        subject,
        due_at: fromLocalInput(due, bootstrap.timezone) ?? "",
        assignee_id: assignee,
        enquiry_id: detail.enquiry.id,
        contact_id: detail.enquiry.contact?.id ?? null,
      });
      if (!res.ok) return void toast.error(res.error);
      setSubject("");
      setDue(nextHour(bootstrap.timezone));
      await reload();
    });
  }

  function toggle(id: string, done: boolean) {
    startTransition(async () => {
      const res = await setTasksDoneAction([id], done);
      if (!res.ok) toast.error(res.error);
      await reload();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canManage && (
        <form onSubmit={add} className="grid gap-2 rounded-lg border p-3">
          <div className="grid grid-cols-[8rem_1fr] gap-2">
            <OptionSelect
              allowNone={false}
              value={type}
              options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
              onChange={(v) => setType((v ?? "other") as TaskType)}
            />
            <Input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
              placeholder="What needs doing?"
              aria-label="Task subject"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
              aria-label="Due"
            />
            <OptionSelect
              noneLabel="Unassigned"
              value={assignee}
              options={bootstrap.users.map((u) => ({ value: u.id, label: u.label }))}
              onChange={setAssignee}
            />
          </div>
          <Button
            type="submit"
            className="justify-self-end"
            disabled={pending || !subject.trim() || !due}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Plus />} Add task
          </Button>
        </form>
      )}
      {detail.tasks.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tasks for this enquiry yet.</p>
      ) : (
        <ul className="divide-y">
          {detail.tasks.map((t) => {
            const s = dueState(t, new Date());
            return (
              <li key={t.id} className="flex items-center gap-3 py-2 text-sm">
                <Checkbox
                  checked={t.done}
                  disabled={!canManage || pending}
                  aria-label={t.done ? `Reopen ${t.subject}` : `Complete ${t.subject}`}
                  onCheckedChange={(c) => toggle(t.id, c === true)}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "flex items-center gap-2 font-medium",
                      t.done && "text-muted-foreground line-through",
                    )}
                  >
                    <Badge variant="outline">
                      {TASK_TYPE_LABELS[t.type as TaskType] ?? t.type}
                    </Badge>
                    <span className="truncate">{t.subject}</span>
                  </p>
                  <p
                    className={cn(
                      "text-xs",
                      s === "overdue" ? "text-destructive" : "text-muted-foreground",
                    )}
                  >
                    {formatDateTime(t.due_at, bootstrap.timezone)}
                    {s === "overdue" && " · overdue"}
                    {t.assignee_id ? ` · ${userName.get(t.assignee_id) ?? "Unknown"}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
