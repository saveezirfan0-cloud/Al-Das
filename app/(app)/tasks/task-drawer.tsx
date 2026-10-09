"use client";

import * as React from "react";
import { Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ContactPicker } from "@/app/(app)/enquiries/contact-picker";
import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { fromLocalInput, toLocalInput } from "@/lib/enquiries/datetime";
import { TASK_TYPES, TASK_TYPE_LABELS, type TaskType } from "@/lib/tasks/constants";

import {
  createTaskAction,
  deleteTasksAction,
  searchContactsForTask,
  setTasksDoneAction,
  updateTaskAction,
  type EnquiryOption,
  type TaskRow,
} from "./actions";
import { EnquiryPicker } from "./enquiry-picker";
import type { TasksBootstrap } from "./types";

type Form = {
  type: TaskType;
  subject: string;
  notes: string;
  due: string;
  assignee_id: string | null;
  contact: { id: string; full_name: string; phone_e164: string | null } | null;
  enquiry: EnquiryOption | null;
  done: boolean;
};

/** Next full hour in the org timezone, as a datetime-local value. */
function defaultDue(tz: string): string {
  const next = new Date(Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000);
  return toLocalInput(next.toISOString(), tz);
}

function blankForm(b: TasksBootstrap, preset?: Partial<Form>): Form {
  return {
    type: "follow_up",
    subject: "",
    notes: "",
    due: defaultDue(b.timezone),
    assignee_id: b.userId,
    contact: null,
    enquiry: null,
    done: false,
    ...preset,
  };
}

function toForm(t: TaskRow, tz: string): Form {
  return {
    type: t.type as TaskType,
    subject: t.subject,
    notes: t.notes ?? "",
    due: toLocalInput(t.due_at, tz),
    assignee_id: t.assignee_id,
    contact: t.contact,
    enquiry:
      t.enquiry && !t.enquiry.deleted_at
        ? { id: t.enquiry.id, number: t.enquiry.number, title: t.enquiry.title }
        : null,
    done: t.done,
  };
}

export type TaskDraft = { open: boolean; task: TaskRow | null; preset?: Partial<Form> };

/** Create or edit a task. */
export function TaskDrawer({
  draft,
  onClose,
  bootstrap,
  onSaved,
}: {
  draft: TaskDraft;
  onClose: () => void;
  bootstrap: TasksBootstrap;
  onSaved: () => void;
}) {
  const editing = draft.task;
  const [form, setForm] = React.useState<Form>(() => blankForm(bootstrap));
  const [pending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (!draft.open) return;
    setForm(editing ? toForm(editing, bootstrap.timezone) : blankForm(bootstrap, draft.preset));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.open, editing?.id]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const canManage = bootstrap.can.manage;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const payload = {
      type: form.type,
      subject: form.subject,
      notes: form.notes,
      due_at: fromLocalInput(form.due, bootstrap.timezone) ?? "",
      assignee_id: form.assignee_id,
      contact_id: form.contact?.id ?? null,
      enquiry_id: form.enquiry?.id ?? null,
    };
    startTransition(async () => {
      if (editing) {
        const res = await updateTaskAction(editing.id, payload);
        if (!res.ok) return void toast.error(res.error);
        if (form.done !== editing.done) {
          const doneRes = await setTasksDoneAction([editing.id], form.done);
          if (!doneRes.ok) toast.error(doneRes.error);
        }
        toast.success(res.message ?? "Saved.");
      } else {
        const res = await createTaskAction(payload);
        if (!res.ok) return void toast.error(res.error);
        if (form.done) {
          const doneRes = await setTasksDoneAction([res.data.id], true);
          if (!doneRes.ok) toast.error(doneRes.error);
        }
        toast.success(res.message ?? "Task created.");
      }
      onSaved();
      onClose();
    });
  }

  return (
    <Sheet open={draft.open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b">
          <SheetTitle>{editing ? "Edit task" : "New task"}</SheetTitle>
          <SheetDescription>
            {editing
              ? `Created ${new Date(editing.created_at).toLocaleDateString()}`
              : "The assignee gets a reminder when it is due."}
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <div className="grid flex-1 content-start gap-4 overflow-y-auto p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="t-type">Type</Label>
                <OptionSelect
                  id="t-type"
                  allowNone={false}
                  disabled={!canManage}
                  value={form.type}
                  options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
                  onChange={(v) => set({ type: (v ?? "other") as TaskType })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-due">Due</Label>
                <Input
                  id="t-due"
                  type="datetime-local"
                  required
                  disabled={!canManage}
                  value={form.due}
                  onChange={(e) => set({ due: e.target.value })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-subject">Subject</Label>
              <Input
                id="t-subject"
                required
                maxLength={200}
                disabled={!canManage}
                value={form.subject}
                onChange={(e) => set({ subject: e.target.value })}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-assignee">Assigned to</Label>
              <OptionSelect
                id="t-assignee"
                noneLabel="Unassigned"
                disabled={!canManage}
                value={form.assignee_id}
                options={bootstrap.users.map((u) => ({ value: u.id, label: u.label }))}
                onChange={(v) => set({ assignee_id: v })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-contact">Contact</Label>
              <ContactPicker
                id="t-contact"
                search={searchContactsForTask}
                value={form.contact}
                disabled={!canManage || !bootstrap.can.contacts}
                onChange={(contact) => set({ contact })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-enquiry">Enquiry</Label>
              <EnquiryPicker
                id="t-enquiry"
                value={form.enquiry}
                disabled={!canManage || !bootstrap.can.enquiries}
                onChange={(enquiry) => set({ enquiry })}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-notes">Notes</Label>
              <Textarea
                id="t-notes"
                rows={4}
                maxLength={2000}
                disabled={!canManage}
                value={form.notes}
                onChange={(e) => set({ notes: e.target.value })}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.done}
                disabled={!canManage}
                onCheckedChange={(c) => set({ done: c === true })}
              />{" "}
              Mark as done
            </label>
          </div>
          {canManage && (
            <div className="flex items-center gap-2 border-t p-4">
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm("Delete this task?")) return;
                    startTransition(async () => {
                      const res = await deleteTasksAction([editing.id]);
                      if (!res.ok) return void toast.error(res.error);
                      toast.success(res.message ?? "Deleted.");
                      onSaved();
                      onClose();
                    });
                  }}
                >
                  <Trash2 /> Delete
                </Button>
              )}
              <Button type="button" variant="ghost" className="ml-auto" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !form.subject.trim() || !form.due}>
                {pending ? <Loader2 className="animate-spin" /> : <Save />}{" "}
                {editing ? "Save" : "Create task"}
              </Button>
            </div>
          )}
        </form>
      </SheetContent>
    </Sheet>
  );
}
