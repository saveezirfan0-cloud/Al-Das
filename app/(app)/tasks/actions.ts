"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { searchContactOptions, type ContactOption } from "@/lib/contacts/search-options";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/types";
import { TASK_TYPES } from "@/lib/tasks/constants";
import { TASK_STATES, taskStateRange } from "@/lib/tasks/range";
import {
  createTask,
  deleteTasks,
  setTasksDone,
  TaskError,
  updateTask,
  type TaskCtx,
} from "@/lib/tasks/service";

export type ActionResult<T = undefined> =
  | (T extends undefined ? { ok: true; message?: string } : { ok: true; message?: string; data: T })
  | { ok: false; error: string };

const uuid = z.string().uuid();
const uuids = z.array(uuid).min(1).max(1000);

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function refresh() {
  revalidatePath("/tasks");
  revalidatePath("/enquiries");
}

async function ctxFor(perm: "tasks.view" | "tasks.manage"): Promise<{
  ctx: TaskCtx;
  timezone: string;
  canContacts: boolean;
  canEnquiries: boolean;
  userId: string;
}> {
  const member = await requirePerm(perm);
  return {
    ctx: { admin: createAdminClient(), orgId: member.orgId, userId: member.userId },
    timezone: member.org.timezone,
    canContacts: can(member, "contacts.view"),
    canEnquiries: can(member, "enquiries.view"),
    userId: member.userId,
  };
}

function describe(e: unknown, fallback: string): string {
  if (e instanceof TaskError) return e.message;
  console.error("[tasks] action failed", e instanceof Error ? e.name : "unknown");
  return fallback;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export type TaskRow = Tables<"tasks"> & {
  contact: { id: string; full_name: string; phone_e164: string | null } | null;
  enquiry: { id: string; number: number; title: string; deleted_at: string | null } | null;
};

const listSchema = z.object({
  assignee: z.union([z.literal("me"), z.literal("all"), uuid]).default("me"),
  state: z.enum(TASK_STATES).default("open"),
  type: z.enum(TASK_TYPES).nullable().optional(),
  search: z.string().max(200).nullable().optional(),
  sort: z.enum(["due_at", "created_at", "subject"]).default("due_at"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
});
export type ListTasksInput = z.input<typeof listSchema>;

export async function listTasks(
  raw: ListTasksInput,
): Promise<ActionResult<{ rows: TaskRow[]; total: number }>> {
  const { ctx, timezone, userId, canContacts, canEnquiries } = await ctxFor("tasks.view");
  const parsed = listSchema.safeParse(raw);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid query");
  const q = parsed.data;
  const range = taskStateRange(q.state, new Date(), timezone);

  let query = ctx.admin
    .from("tasks")
    .select(
      "*, contact:contacts(id, full_name, phone_e164), enquiry:enquiries(id, number, title, deleted_at)",
      { count: "exact" },
    )
    .eq("org_id", ctx.orgId);
  if (q.assignee === "me") query = query.eq("assignee_id", userId);
  else if (q.assignee !== "all") query = query.eq("assignee_id", q.assignee);
  if (range.done !== undefined) query = query.eq("done", range.done);
  if (range.dueBefore) query = query.lt("due_at", range.dueBefore.toISOString());
  if (range.dueFrom) query = query.gte("due_at", range.dueFrom.toISOString());
  if (range.dueTo) query = query.lt("due_at", range.dueTo.toISOString());
  if (q.type) query = query.eq("type", q.type);
  const term = q.search?.trim();
  if (term) query = query.ilike("subject", `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);

  const from = (q.page - 1) * q.pageSize;
  const { data, count, error } = await query
    .order(q.sort, { ascending: q.dir === "asc" })
    .order("id")
    .range(from, from + q.pageSize - 1);
  if (error) return fail("Could not load tasks.");
  // Contact names/phones and enquiry titles are patient data: only for users who may open those records.
  const rows = ((data ?? []) as unknown as TaskRow[]).map((t) => ({
    ...t,
    contact: canContacts ? t.contact : null,
    enquiry: canEnquiries ? t.enquiry : null,
  }));
  return { ok: true, data: { rows, total: count ?? 0 } };
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

const taskSchema = z.object({
  type: z.enum(TASK_TYPES),
  subject: z.string().trim().min(1, "Subject is required").max(200),
  notes: z.preprocess(blank, z.string().trim().max(2000).nullable().optional()),
  due_at: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), "Choose a date and time")
    .transform((v) => new Date(v).toISOString()),
  assignee_id: z.preprocess(blank, uuid.nullable().optional()),
  contact_id: z.preprocess(blank, uuid.nullable().optional()),
  enquiry_id: z.preprocess(blank, uuid.nullable().optional()),
});

export async function createTaskAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { ctx, canContacts, canEnquiries } = await ctxFor("tasks.manage");
  const parsed = taskSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid task");
  const d = parsed.data;
  if ((d.contact_id && !canContacts) || (d.enquiry_id && !canEnquiries))
    return fail("You cannot link records you do not have access to.");
  try {
    const created = await createTask(ctx, {
      type: d.type,
      subject: d.subject,
      notes: d.notes ?? null,
      dueAt: d.due_at,
      assigneeId: d.assignee_id === undefined ? undefined : d.assignee_id,
      contactId: d.contact_id ?? null,
      enquiryId: d.enquiry_id ?? null,
    });
    refresh();
    return { ok: true, message: "Task created.", data: created };
  } catch (e) {
    return fail(describe(e, "Could not create the task."));
  }
}

export async function updateTaskAction(id: string, input: unknown): Promise<ActionResult> {
  const { ctx, canContacts, canEnquiries } = await ctxFor("tasks.manage");
  const parsed = taskSchema.safeParse(input);
  if (!uuid.safeParse(id).success || !parsed.success)
    return fail(
      parsed.success ? "Invalid id" : (parsed.error.issues[0]?.message ?? "Invalid task"),
    );
  const d = parsed.data;
  try {
    await updateTask(ctx, id, {
      type: d.type,
      subject: d.subject,
      notes: d.notes ?? null,
      dueAt: d.due_at,
      assigneeId: d.assignee_id ?? null,
      // A user who cannot see contacts / enquiries never receives the link, so leave it as it is
      // instead of treating the missing value as "unlink".
      contactId: canContacts ? (d.contact_id ?? null) : undefined,
      enquiryId: canEnquiries ? (d.enquiry_id ?? null) : undefined,
    });
    refresh();
    return { ok: true, message: "Saved." };
  } catch (e) {
    return fail(describe(e, "Could not save the task."));
  }
}

export async function setTasksDoneAction(ids: string[], done: boolean): Promise<ActionResult> {
  const { ctx } = await ctxFor("tasks.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success) return fail("Select at least one task.");
  try {
    const n = await setTasksDone(ctx, parsed.data, done);
    refresh();
    return {
      ok: true,
      message:
        n === 0
          ? "Nothing to change."
          : `${n} task${n === 1 ? "" : "s"} ${done ? "completed" : "reopened"}.`,
    };
  } catch (e) {
    return fail(describe(e, "Could not update the tasks."));
  }
}

export async function assignTasksAction(
  ids: string[],
  assigneeId: string | null,
): Promise<ActionResult> {
  const { ctx } = await ctxFor("tasks.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success || (assigneeId !== null && !uuid.safeParse(assigneeId).success))
    return fail("Invalid request");
  try {
    for (const id of parsed.data) await updateTask(ctx, id, { assigneeId });
    refresh();
    return { ok: true, message: "Reassigned." };
  } catch (e) {
    return fail(describe(e, "Could not reassign the tasks."));
  }
}

export async function deleteTasksAction(ids: string[]): Promise<ActionResult> {
  const { ctx } = await ctxFor("tasks.manage");
  const parsed = uuids.safeParse(ids);
  if (!parsed.success) return fail("Select at least one task.");
  try {
    const n = await deleteTasks(ctx, parsed.data);
    refresh();
    return { ok: true, message: `${n} task${n === 1 ? "" : "s"} deleted.` };
  } catch (e) {
    return fail(describe(e, "Could not delete the tasks."));
  }
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

export async function searchContactsForTask(
  q: string,
): Promise<ActionResult<{ rows: ContactOption[] }>> {
  const { ctx, canContacts } = await ctxFor("tasks.manage");
  if (!canContacts) return fail("You do not have access to contacts.");
  const rows = await searchContactOptions(ctx.admin, ctx.orgId, q);
  return rows ? { ok: true, data: { rows } } : fail("Search failed.");
}

export type EnquiryOption = { id: string; number: number; title: string };

export async function searchEnquiriesForTask(
  q: string,
): Promise<ActionResult<{ rows: EnquiryOption[] }>> {
  const { ctx, canEnquiries } = await ctxFor("tasks.manage");
  if (!canEnquiries) return fail("You do not have access to enquiries.");
  const term = q.trim().slice(0, 100);
  if (term.length < 1) return { ok: true, data: { rows: [] } };
  let query = ctx.admin
    .from("enquiries")
    .select("id, number, title")
    .eq("org_id", ctx.orgId)
    .is("deleted_at", null)
    .limit(10);
  const asNumber = /^#?(\d{1,9})$/.exec(term);
  query = asNumber
    ? query.eq("number", Number(asNumber[1]))
    : query.ilike("title", `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
  const { data, error } = await query.order("number", { ascending: false });
  if (error) return fail("Search failed.");
  return { ok: true, data: { rows: data ?? [] } };
}
