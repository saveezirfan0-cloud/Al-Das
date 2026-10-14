"use client";

import * as React from "react";
import Link from "next/link";
import { RecordHistorySection } from "@/components/history/record-history";
import { ListChecks, Loader2, MessageSquare, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ContactPicker } from "@/app/(app)/enquiries/contact-picker";
import { OptionSelect } from "@/app/(app)/enquiries/option-select";
import { useConfirm } from "@/components/shell/confirm-dialog";
import { Button } from "@/components/ui/button";
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
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_RECURRENCES,
  TASK_RECURRENCE_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  type TaskRecurrence,
  type TaskStatus,
} from "@/lib/tasks/status";

import {
  createTaskAction,
  deleteTasksAction,
  searchContactsForTask,
  updateTaskAction,
  type EnquiryOption,
  type TaskRow,
} from "./actions";
import { EnquiryPicker } from "./enquiry-picker";
import { TaskParts } from "./task-parts";
import type { TasksBootstrap } from "./types";

type Form = {
  type: TaskType;
  subject: string;
  notes: string;
  due: string;
  assignee_id: string | null;
  contact: { id: string; full_name: string; phone_e164: string | null } | null;
  enquiry: EnquiryOption | null;
  /** Phase B: the task's branch (null = no branch). */
  location_id: string | null;
  /** Phase F (tasks v2). Status "done" ticks the task off. */
  status: TaskStatus;
  priority: TaskPriority;
  team_id: string | null;
  recurrence: TaskRecurrence | null;
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
    location_id: b.currentBranch,
    status: "todo",
    priority: "normal",
    team_id: null,
    recurrence: null,
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
    location_id: t.location_id,
    status: (t.status as TaskStatus) ?? (t.done ? "done" : "todo"),
    priority: (t.priority as TaskPriority) ?? "normal",
    team_id: t.team_id,
    recurrence: (t.recurrence as TaskRecurrence | null) ?? null,
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
  const [confirm, confirmDialog] = useConfirm();

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
      location_id: form.location_id,
      status: form.status,
      priority: form.priority,
      team_id: form.team_id,
      recurrence: form.recurrence,
    };
    startTransition(async () => {
      if (editing) {
        const res = await updateTaskAction(editing.id, payload);
        if (!res.ok) return void toast.error(res.error);
        toast.success(res.message ?? "Saved.");
      } else {
        const res = await createTaskAction(payload);
        if (!res.ok) return void toast.error(res.error);
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
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="t-status">Status</Label>
                <OptionSelect
                  id="t-status"
                  allowNone={false}
                  disabled={!canManage}
                  value={form.status}
                  options={TASK_STATUSES.map((s) => ({ value: s, label: TASK_STATUS_LABELS[s] }))}
                  onChange={(v) => set({ status: (v ?? "todo") as TaskStatus })}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="t-priority">Priority</Label>
                <OptionSelect
                  id="t-priority"
                  allowNone={false}
                  disabled={!canManage}
                  value={form.priority}
                  options={TASK_PRIORITIES.map((p) => ({
                    value: p,
                    label: TASK_PRIORITY_LABELS[p],
                  }))}
                  onChange={(v) => set({ priority: (v ?? "normal") as TaskPriority })}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
                <Label htmlFor="t-team">Team</Label>
                <OptionSelect
                  id="t-team"
                  noneLabel="No team"
                  disabled={!canManage}
                  value={form.team_id}
                  options={bootstrap.teams.map((t) => ({ value: t.id, label: t.name }))}
                  onChange={(v) => set({ team_id: v })}
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="t-repeat">Repeats</Label>
              <OptionSelect
                id="t-repeat"
                noneLabel="Does not repeat"
                disabled={!canManage}
                value={form.recurrence}
                options={TASK_RECURRENCES.map((r) => ({
                  value: r,
                  label: TASK_RECURRENCE_LABELS[r],
                }))}
                onChange={(v) => set({ recurrence: (v as TaskRecurrence | null) ?? null })}
              />
              {form.recurrence && (
                <p className="text-muted-foreground text-xs">
                  The next one is made when this is done, or at its due time if nobody ticks it off.
                </p>
              )}
            </div>
            {(bootstrap.branches.length > 1 || form.location_id) && (
              <div className="grid gap-1.5">
                <Label htmlFor="t-branch">Branch</Label>
                <OptionSelect
                  id="t-branch"
                  noneLabel="No branch"
                  disabled={!canManage}
                  value={form.location_id}
                  options={[
                    ...bootstrap.branches.map((b) => ({ value: b.id, label: b.name })),
                    // A branch that is no longer active stays readable on the task it is set on.
                    ...(form.location_id &&
                    !bootstrap.branches.some((b) => b.id === form.location_id)
                      ? [
                          {
                            value: form.location_id,
                            label: bootstrap.branchNames[form.location_id] ?? "Other branch",
                          },
                        ]
                      : []),
                  ]}
                  onChange={(v) => set({ location_id: v })}
                />
              </div>
            )}
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
            {editing?.conversation_id && (
              <Link
                href={`/inbox?c=${editing.conversation_id}`}
                className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
              >
                <MessageSquare className="size-4" aria-hidden /> Open the chat it came from
              </Link>
            )}
            {editing?.checklist_template_id && (
              <p className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                <ListChecks className="size-4" aria-hidden /> Made from the branch&apos;s daily
                checklist.
              </p>
            )}
            {editing ? (
              <TaskParts
                taskId={editing.id}
                timezone={bootstrap.timezone}
                users={bootstrap.users}
                canManage={canManage}
                canMedia={bootstrap.can.media}
              />
            ) : (
              <p className="text-muted-foreground text-xs">
                Checklist items, comments and files can be added once the task is created.
              </p>
            )}
            {editing && <RecordHistorySection table="tasks" recordId={editing.id} />}
          </div>
          {canManage && (
            <div className="flex items-center gap-2 border-t p-4">
              {editing && (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  disabled={pending}
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Delete this task?",
                      description:
                        "It can be restored from Settings, Recently deleted for a while.",
                      confirmLabel: "Delete",
                      destructive: true,
                    });
                    if (!ok) return;
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
        {confirmDialog}
      </SheetContent>
    </Sheet>
  );
}
