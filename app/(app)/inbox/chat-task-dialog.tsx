"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { fromLocalInput, toLocalInput } from "@/lib/enquiries/datetime";
import { TASK_TYPES, TASK_TYPE_LABELS, type TaskType } from "@/lib/tasks/constants";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from "@/lib/tasks/status";

import { createTaskFromConversation } from "./work-actions";

function nextHour(tz: string): string {
  const next = new Date(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000);
  return toLocalInput(next.toISOString(), tz);
}

/**
 * "Create task" from a chat (Phase F): the subject starts from the patient's name, the task is linked to the patient
 * and this chat, and it lands in the chat's branch.
 */
export function ChatTaskDialog({
  open,
  onOpenChange,
  conversationId,
  contactName,
  timezone,
  me,
  people,
  branchName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
  contactName: string;
  timezone: string;
  me: string;
  people: Array<{ id: string; name: string }>;
  branchName: string | null;
}) {
  const [subject, setSubject] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState<string | null>(me);
  const [type, setType] = useState<TaskType>("follow_up");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setSubject(`Follow up with ${contactName}`.slice(0, 200));
    setDue(nextHour(timezone));
    setAssignee(me);
    setType("follow_up");
    setPriority("normal");
    setNotes("");
  }, [open, contactName, timezone, me]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const r = await createTaskFromConversation({
        conversation_id: conversationId,
        subject,
        due_at: fromLocalInput(due, timezone) ?? "",
        assignee_id: assignee,
        type,
        priority,
        notes: notes || undefined,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.message ?? "Task created.", {
        action: {
          label: "Open",
          onClick: () => window.location.assign(`/tasks?task=${r.data.id}`),
        },
      });
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create a task from this chat</DialogTitle>
            <DialogDescription>
              Linked to the patient and this conversation
              {branchName ? `, in ${branchName}` : ""}. See it under{" "}
              <Link href="/tasks" className="underline">
                Tasks
              </Link>
              .
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-subject">Subject</Label>
            <Input
              id="ct-subject"
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ct-type">Type</Label>
              <OptionSelect
                id="ct-type"
                allowNone={false}
                value={type}
                options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
                onChange={(v) => setType((v ?? "follow_up") as TaskType)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ct-priority">Priority</Label>
              <OptionSelect
                id="ct-priority"
                allowNone={false}
                value={priority}
                options={TASK_PRIORITIES.map((p) => ({ value: p, label: TASK_PRIORITY_LABELS[p] }))}
                onChange={(v) => setPriority((v ?? "normal") as TaskPriority)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="ct-due">Due</Label>
              <Input
                id="ct-due"
                type="datetime-local"
                required
                value={due}
                onChange={(e) => setDue(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ct-assignee">Assigned to</Label>
              <OptionSelect
                id="ct-assignee"
                noneLabel="Unassigned"
                value={assignee}
                options={people.map((p) => ({ value: p.id, label: p.name }))}
                onChange={setAssignee}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ct-notes">Notes</Label>
            <Textarea
              id="ct-notes"
              rows={3}
              maxLength={2000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !subject.trim() || !due}>
              {pending && <Loader2 className="animate-spin" />} Create task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
