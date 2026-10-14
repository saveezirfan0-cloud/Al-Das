import "server-only";

import { recordAudit } from "@/lib/audit";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { emit } from "@/lib/events/emit";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { notify } from "@/lib/notify/dispatch-db";
import { softDelete } from "@/lib/soft-delete/server";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesUpdate } from "@/lib/supabase/types";
import { taskAudience } from "@/lib/tasks/audience";
import { reminderDedupeKey, reminderRunAt } from "@/lib/tasks/due";
import type { TaskType } from "@/lib/tasks/constants";
import { nextOccurrence, recurrenceDedupeKey } from "@/lib/tasks/recurrence";
import type { TaskPriority, TaskRecurrence, TaskStatus } from "@/lib/tasks/status";

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
  appointmentId?: string | null;
  /**
   * Phase B: the task's branch. Null/undefined on create lets the database take the appointment's, else the enquiry's
   * branch (tasks_branch_default); the caller checks the member may use it.
   */
  locationId?: string | null;
  /** Phase F (tasks v2). */
  priority?: TaskPriority;
  status?: TaskStatus;
  teamId?: string | null;
  /** The chat a task was made from ("Create task" in the inbox); the caller checked the member may see it. */
  conversationId?: string | null;
  recurrence?: TaskRecurrence | null;
};

function dbError(error: { code?: string; message: string }, fallback: string): TaskError {
  if (error.code === "23514")
    return new TaskError("One of the selected values is not valid for this workspace.");
  console.error("[tasks] db error", { code: error.code });
  return new TaskError(fallback);
}

async function orgSettings(ctx: TaskCtx): Promise<{ settings: unknown; timezone: string }> {
  const { data: org } = await ctx.admin
    .from("orgs")
    .select("settings, timezone")
    .eq("id", ctx.orgId)
    .single();
  return { settings: org?.settings, timezone: org?.timezone || "UTC" };
}

/** Schedules the "task is due" reminder through scheduled_jobs (never an in-memory timer). */
export async function scheduleReminder(
  ctx: TaskCtx,
  task: Pick<Tables<"tasks">, "id" | "due_at" | "done">,
) {
  if (task.done) return;
  const { settings } = await orgSettings(ctx);
  const lead = readEnquirySettings(settings).task_reminder_lead_minutes;
  const dueAt = new Date(task.due_at);
  const runAt = reminderRunAt(dueAt, lead, new Date());
  if (!runAt) return;
  await scheduleJob({
    kind: "task.due",
    orgId: ctx.orgId,
    runAt,
    payload: { task_id: task.id, due_at: dueAt.toISOString() },
    dedupeKey: reminderDedupeKey(task.id, dueAt),
  }).catch((e) =>
    console.error("[tasks] reminder schedule failed", e instanceof Error ? e.message : e),
  );
}

/**
 * A recurring task makes the next one at its due time even if nobody ticked it off (task.recur), and at once when it
 * is completed. Both go through spawnNextOccurrence, which is idempotent.
 */
async function scheduleRecurrence(
  ctx: TaskCtx,
  task: Pick<Tables<"tasks">, "id" | "due_at" | "recurrence">,
) {
  if (!task.recurrence) return;
  const dueAt = new Date(task.due_at);
  await scheduleJob({
    kind: "task.recur",
    orgId: ctx.orgId,
    runAt: dueAt.getTime() > Date.now() ? dueAt : new Date(),
    payload: { task_id: task.id, due_at: dueAt.toISOString() },
    dedupeKey: recurrenceDedupeKey(task.id, dueAt),
  }).catch((e) =>
    console.error("[tasks] recurrence schedule failed", e instanceof Error ? e.message : e),
  );
}

/**
 * Tells a new assignee when a person gave them the task (not themselves): ids only in push and e-mail. Tasks made by
 * the system (a failed reminder's call task, a daily checklist, the next of a series) have their own notifications.
 */
async function notifyAssigned(
  ctx: TaskCtx,
  task: { id: string; subject: string; location_id: string | null },
  assigneeId: string | null,
) {
  if (!assigneeId || !ctx.userId || assigneeId === ctx.userId) return;
  const recipients = await taskAudience(ctx.admin, ctx.orgId, [assigneeId], task.location_id);
  if (recipients.length === 0) return;
  await notify(ctx.admin, {
    orgId: ctx.orgId,
    userIds: recipients,
    event: "task.assigned",
    type: "task.assigned",
    title: "Task assigned to you",
    // The bell is private to the recipient; push and e-mail use the fixed generic sentence.
    body: task.subject.slice(0, 140),
    payload: { task_id: task.id },
    ids: { task_id: task.id },
  });
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
      // undefined = default to the creator; null = deliberately unassigned
      assignee_id: input.assigneeId === undefined ? ctx.userId : input.assigneeId,
      contact_id: input.contactId ?? null,
      enquiry_id: input.enquiryId ?? null,
      appointment_id: input.appointmentId ?? null,
      location_id: input.locationId ?? null,
      priority: input.priority ?? "normal",
      status: input.status ?? "todo",
      team_id: input.teamId ?? null,
      conversation_id: input.conversationId ?? null,
      recurrence: input.recurrence ?? null,
      created_by: ctx.userId,
    })
    .select(
      "id, subject, due_at, done, assignee_id, contact_id, enquiry_id, location_id, recurrence",
    )
    .single();
  if (error || !data) throw dbError(error ?? { message: "no row" }, "Could not create the task.");
  await scheduleReminder(ctx, data);
  await scheduleRecurrence(ctx, data);
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.created",
    entity: "task",
    entityId: data.id,
  });
  await emit(ctx.orgId, "task.created", {
    task_id: data.id,
    enquiry_id: data.enquiry_id,
    contact_id: data.contact_id,
    assignee_id: data.assignee_id,
    actor_id: ctx.userId,
  });
  await notifyAssigned(ctx, data, data.assignee_id);
  return { id: data.id };
}

export type TaskPatch = Partial<Omit<TaskInput, "type">> & { type?: TaskType };

export async function updateTask(ctx: TaskCtx, id: string, patch: TaskPatch): Promise<void> {
  const { data: before } = await ctx.admin
    .from("tasks")
    .select("*")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!before) throw new TaskError("Task not found.");
  const update: TablesUpdate<"tasks"> = {};
  if (patch.type !== undefined) update.type = patch.type;
  if (patch.subject !== undefined) update.subject = patch.subject;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.dueAt !== undefined) update.due_at = patch.dueAt;
  if (patch.assigneeId !== undefined) update.assignee_id = patch.assigneeId;
  if (patch.contactId !== undefined) update.contact_id = patch.contactId;
  if (patch.enquiryId !== undefined) update.enquiry_id = patch.enquiryId;
  if (patch.locationId !== undefined) update.location_id = patch.locationId;
  if (patch.priority !== undefined) update.priority = patch.priority;
  if (patch.teamId !== undefined) update.team_id = patch.teamId;
  if (patch.recurrence !== undefined) update.recurrence = patch.recurrence;
  if (patch.status !== undefined && patch.status !== before.status) {
    update.status = patch.status;
    // The database keeps done / done_at in step; record who finished it.
    if (patch.status === "done") update.completed_by = ctx.userId;
  }
  if (Object.keys(update).length === 0) return;
  const { data, error } = await ctx.admin
    .from("tasks")
    .update(update)
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .select(
      "id, subject, due_at, done, recurrence, assignee_id, contact_id, enquiry_id, location_id",
    )
    .single();
  if (error || !data) throw dbError(error ?? { message: "no row" }, "Could not save the task.");
  const dueMoved =
    patch.dueAt !== undefined &&
    new Date(patch.dueAt).getTime() !== new Date(before.due_at).getTime();
  if (dueMoved || (before.done && !data.done)) await scheduleReminder(ctx, data);
  if (dueMoved || (data.recurrence && data.recurrence !== before.recurrence))
    await scheduleRecurrence(ctx, data);
  if (!before.done && data.done) await afterCompleted(ctx, data);
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.updated",
    entity: "task",
    entityId: id,
    diff: { fields: Object.keys(update) },
  });
  if (data.assignee_id && data.assignee_id !== before.assignee_id)
    await notifyAssigned(ctx, data, data.assignee_id);
}

/** A task just finished: the domain event, and the next one of a recurring series. */
async function afterCompleted(
  ctx: TaskCtx,
  t: Pick<
    Tables<"tasks">,
    "id" | "enquiry_id" | "contact_id" | "assignee_id" | "recurrence" | "due_at"
  >,
) {
  await emit(ctx.orgId, "task.completed", {
    task_id: t.id,
    enquiry_id: t.enquiry_id,
    contact_id: t.contact_id,
    assignee_id: t.assignee_id,
    actor_id: ctx.userId,
  });
  if (t.recurrence) await spawnNextOccurrence(ctx, t.id);
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
    .is("deleted_at", null)
    .eq("done", !done)
    .select("id, due_at, done, assignee_id, contact_id, enquiry_id, recurrence");
  if (error) throw dbError(error, "Could not update the tasks.");
  for (const t of data ?? []) {
    if (done) await afterCompleted(ctx, t);
    else await scheduleReminder(ctx, t);
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

/**
 * The next task of a recurring series (idempotent: public.task_spawn_next makes at most one per series and due time,
 * and none once a later one exists). The new task gets its own due reminder and its own "make the next one" job.
 */
export async function spawnNextOccurrence(
  ctx: TaskCtx,
  taskId: string,
  now: Date = new Date(),
): Promise<string | null> {
  const { data: t } = await ctx.admin
    .from("tasks")
    .select("id, due_at, recurrence, deleted_at")
    .eq("org_id", ctx.orgId)
    .eq("id", taskId)
    .maybeSingle();
  if (!t || !t.recurrence || t.deleted_at) return null;
  const { timezone } = await orgSettings(ctx);
  const next = nextOccurrence(new Date(t.due_at), t.recurrence as TaskRecurrence, timezone, now);
  const { data: newId, error } = await ctx.admin.rpc("task_spawn_next", {
    p_org_id: ctx.orgId,
    p_task_id: t.id,
    p_next_due: next.toISOString(),
  });
  if (error) {
    console.error("[tasks] next occurrence failed", { code: error.code });
    return null;
  }
  if (!newId) return null;
  const created = { id: newId as string, due_at: next.toISOString(), done: false };
  await scheduleReminder(ctx, created);
  await scheduleRecurrence(ctx, { ...created, recurrence: t.recurrence });
  return created.id;
}

/**
 * Soft-deletes tasks into the bin (docs/35): they vanish from lists, counts and reminders and can be restored from
 * Settings, Recently deleted until the org's restore window ends; the nightly purge then removes them.
 */
export async function deleteTasks(ctx: TaskCtx, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  let moved: string[];
  try {
    moved = await softDelete(ctx.admin, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      entity: "task",
      ids,
    });
  } catch {
    throw new TaskError("Could not delete the tasks.");
  }
  await recordAudit(ctx.admin, {
    orgId: ctx.orgId,
    userId: ctx.userId,
    action: "task.deleted",
    entity: "task",
    entityId: moved.length === 1 ? moved[0] : undefined,
    diff: { count: moved.length, restorable: true },
  });
  return moved.length;
}

/** After a restore: an open task gets its due reminder back (a reminder that fell due in the bin is not resent). */
export async function afterTaskRestored(ctx: TaskCtx, id: string): Promise<void> {
  const { data } = await ctx.admin
    .from("tasks")
    .select("id, due_at, done")
    .eq("org_id", ctx.orgId)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (data) await scheduleReminder(ctx, data);
}
