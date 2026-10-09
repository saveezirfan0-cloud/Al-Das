import "server-only";

import { recordAudit } from "@/lib/audit";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { emit } from "@/lib/events/emit";
import { scheduleJob } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesUpdate } from "@/lib/supabase/types";
import { reminderDedupeKey, reminderRunAt } from "@/lib/tasks/due";
import type { TaskType } from "@/lib/tasks/constants";

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

export type TaskCtx = { admin: AdminClient; orgId: string; userId: string | null };

export type TaskInput = {
  type: TaskType;
  subject: string;
  notes?: string | null;
  dueAt: string;
  assigneeId?: string | null;
  contactId?: string | null;
  enquiryId?: string | null;
};

function dbError(error: { code?: string; message: string }, fallback: string): TaskError {
  if (error.code === "23514") return new TaskError("One of the selected values is not valid for this workspace.");
  console.error("[tasks] db error", { code: error.code });
  return new TaskError(fallback);
}

/** Schedules the "task is due" reminder through scheduled_jobs (never an in-memory timer). */
async function scheduleReminder(ctx: TaskCtx, task: Pick<Tables<"tasks">, "id" | "due_at" | "done">) {
  if (task.done) return;
  const { data: org } = await ctx.admin.from("orgs").select("settings").eq("id", ctx.orgId).single();
  const lead = readEnquirySettings(org?.settings).task_reminder_lead_minutes;
  const dueAt = new Date(task.due_at);
  const runAt = reminderRunAt(dueAt, lead, new Date());
  if (!runAt) return;
  await scheduleJob({
    kind: "task.due",
    orgId: ctx.orgId,
    runAt,
    payload: { task_id: task.id, due_at: dueAt.toISOString() },
    dedupeKey: reminderDedupeKey(task.id, dueAt),
  }).catch((e) => console.error("[tasks] reminder schedule failed", e instanceof Error ? e.message : e));
}

export async function createTask(ctx: TaskCtx, input: TaskInput): Promise<{ id: string }> {
  const { data, error } = await ctx.admin
    .from("tasks")
    .insert({
      org_id: ctx.orgId,
      type: input.type,
      subject: input.subject,
      notes: input.notes ?? null,
      due_at: input.dueAt,
      assignee_id: input.assigneeId ?? ctx.userId,
      contact_id: input.contactId ?? null,
      enquiry_id: input.enquiryId ?? null,
      created_by: ctx.userId,
    })
    .select("id, due_at, done, assignee_id")
    .single();
  if (error || !data) throw dbError(error ?? { message: "no row" }, "Could not create the task.");
  await scheduleReminder(ctx, data);
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.created",
    entity: "task",
    entityId: data.id,
  });
  await emit(ctx.orgId, "task.created", { task_id: data.id, assignee_id: data.assignee_id, actor_id: ctx.userId });
  return { id: data.id };
}

export type TaskPatch = Partial<Omit<TaskInput, "type">> & { type?: TaskType };

export async function updateTask(ctx: TaskCtx, id: string, patch: TaskPatch): Promise<void> {
  const { data: before } = await ctx.admin.from("tasks").select("*").eq("org_id", ctx.orgId).eq("id", id).maybeSingle();
  if (!before) throw new TaskError("Task not found.");
  const update: TablesUpdate<"tasks"> = {};
  if (patch.type !== undefined) update.type = patch.type;
  if (patch.subject !== undefined) update.subject = patch.subject;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.dueAt !== undefined) update.due_at = patch.dueAt;
  if (patch.assigneeId !== undefined) update.assignee_id = patch.assigneeId;
  if (patch.contactId !== undefined) update.contact_id = patch.contactId;
  if (patch.enquiryId !== undefined) update.enquiry_id = patch.enquiryId;
  if (Object.keys(update).length === 0) return;
  const { data, error } = await ctx.admin
    .from("tasks")
    .update(update)
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .select("id, due_at, done")
    .single();
  if (error || !data) throw dbError(error ?? { message: "no row" }, "Could not save the task.");
  if (patch.dueAt !== undefined && new Date(patch.dueAt).getTime() !== new Date(before.due_at).getTime()) {
    await scheduleReminder(ctx, data);
  }
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.updated",
    entity: "task",
    entityId: id,
    diff: { fields: Object.keys(update) },
  });
}

/** Marks tasks done / open. Returns how many changed. */
export async function setTasksDone(ctx: TaskCtx, ids: string[], done: boolean): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await ctx.admin
    .from("tasks")
    .update(
      done
        ? { done: true, done_at: new Date().toISOString(), completed_by: ctx.userId }
        : { done: false, done_at: null, completed_by: null },
    )
    .eq("org_id", ctx.orgId)
    .in("id", ids)
    .eq("done", !done)
    .select("id, due_at, done, assignee_id");
  if (error) throw dbError(error, "Could not update the tasks.");
  for (const t of data ?? []) {
    if (done) {
      await emit(ctx.orgId, "task.completed", { task_id: t.id, assignee_id: t.assignee_id, actor_id: ctx.userId });
    } else {
      await scheduleReminder(ctx, t);
    }
  }
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: done ? "task.completed" : "task.reopened",
    entity: "task",
    diff: { count: data?.length ?? 0 },
  });
  return data?.length ?? 0;
}

export async function deleteTasks(ctx: TaskCtx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { data, error } = await ctx.admin.from("tasks").delete().eq("org_id", ctx.orgId).in("id", ids).select("id");
  if (error) throw dbError(error, "Could not delete the tasks.");
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.deleted",
    entity: "task",
    diff: { count: data?.length ?? 0 },
  });
  return data?.length ?? 0;
}
