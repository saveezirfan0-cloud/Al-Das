import "server-only";

import { searchTerm } from "@/lib/enquiries/filter";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { emit } from "@/lib/events/emit";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { createNotification } from "@/lib/notifications";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { TablesUpdate } from "@/lib/supabase/types";
import { isTaskType } from "@/lib/tasks/due";
import type { CreateTaskInput, TaskFilter, UpdateTaskInput } from "@/lib/tasks/schemas";
import type { TaskRow } from "@/lib/tasks/types";

export type Actor = { orgId: string; userId: string };
export type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

const SELECT =
  "id, type, subject, notes, due_at, assignee_id, contact_id, enquiry_id, appointment_id, done, done_at, created_at, " +
  "contacts(first_name, last_name, wa_profile_name, phone_e164), enquiries(number), " +
  "assignee:profiles!tasks_assignee_id_fkey(first_name, last_name, email), creator:profiles!tasks_created_by_fkey(first_name, last_name, email)";

type Profile = { first_name: string; last_name: string; email: string | null } | null;
type Raw = {
  id: string;
  type: string;
  subject: string;
  notes: string | null;
  due_at: string | null;
  assignee_id: string | null;
  contact_id: string | null;
  enquiry_id: string | null;
  appointment_id: string | null;
  done: boolean;
  done_at: string | null;
  created_at: string;
  contacts: {
    first_name: string | null;
    last_name: string | null;
    wa_profile_name: string | null;
    phone_e164: string | null;
  } | null;
  enquiries: { number: number } | null;
  assignee: Profile;
  creator: Profile;
};

const person = (p: Profile) =>
  p ? `${p.first_name} ${p.last_name}`.trim() || (p.email ?? "") : "";

function toRow(r: Raw): TaskRow {
  return {
    id: r.id,
    type: isTaskType(r.type) ? r.type : "other",
    subject: r.subject,
    notes: r.notes,
    due_at: r.due_at,
    assignee_id: r.assignee_id,
    assignee_name: person(r.assignee),
    contact_id: r.contact_id,
    patient: r.contacts ? contactDisplayName(r.contacts) : "",
    enquiry_id: r.enquiry_id,
    enquiry_number: r.enquiries ? Number(r.enquiries.number) : null,
    appointment_id: r.appointment_id,
    done: r.done,
    done_at: r.done_at,
    created_at: r.created_at,
    created_by_name: person(r.creator),
  };
}

export const TASK_PAGE_SIZE = 50;

export async function listTasks(
  admin: AdminClient,
  actor: Actor,
  filter: TaskFilter,
  page = 0,
  now: Date = new Date(),
): Promise<{ rows: TaskRow[]; total: number }> {
  let q = admin
    .from("tasks")
    .select<string, Raw>(SELECT, { count: "exact" })
    .eq("org_id", actor.orgId);
  if (filter.scope === "mine") q = q.eq("assignee_id", actor.userId);
  else if (filter.assignee_id === "unassigned") q = q.is("assignee_id", null);
  else if (filter.assignee_id) q = q.eq("assignee_id", filter.assignee_id);
  if (filter.state === "open") q = q.eq("done", false);
  else if (filter.state === "overdue") q = q.eq("done", false).lt("due_at", now.toISOString());
  else if (filter.state === "done") q = q.eq("done", true);
  if (filter.type) q = q.eq("type", filter.type);
  if (filter.contact_id) q = q.eq("contact_id", filter.contact_id);
  if (filter.enquiry_id) q = q.eq("enquiry_id", filter.enquiry_id);
  if (filter.due_from) q = q.gte("due_at", `${filter.due_from}T00:00:00.000Z`);
  if (filter.due_to) q = q.lte("due_at", `${filter.due_to}T23:59:59.999Z`);
  const term = searchTerm(filter.search);
  if (term) q = q.ilike("subject", `%${term}%`);

  const from = Math.max(page, 0) * TASK_PAGE_SIZE;
  const ordered =
    filter.state === "done"
      ? q.order("done_at", { ascending: false, nullsFirst: false })
      : q.order("due_at", { ascending: true, nullsFirst: false });
  const { data, count, error } = await ordered
    .order("created_at", { ascending: false })
    .range(from, from + TASK_PAGE_SIZE - 1);
  if (error) {
    console.error("[tasks] list failed", error.code, redactText(error.message));
    return { rows: [], total: 0 };
  }
  return { rows: (data ?? []).map(toRow), total: count ?? 0 };
}

/** Open tasks linked to a contact or enquiry (drawer tabs). */
export async function openTasksFor(
  admin: AdminClient,
  orgId: string,
  link: { contact_id?: string; enquiry_id?: string },
): Promise<TaskRow[]> {
  let q = admin.from("tasks").select<string, Raw>(SELECT).eq("org_id", orgId).eq("done", false);
  if (link.enquiry_id) q = q.eq("enquiry_id", link.enquiry_id);
  else if (link.contact_id) q = q.eq("contact_id", link.contact_id);
  else return [];
  const { data } = await q.order("due_at", { ascending: true, nullsFirst: false }).limit(50);
  return (data ?? []).map(toRow);
}

async function isActiveMember(admin: AdminClient, orgId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("memberships")
    .select("user_id")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();
  return !!data;
}

async function checkLinks(
  admin: AdminClient,
  orgId: string,
  input: { assignee_id?: string | null; contact_id?: string | null; enquiry_id?: string | null },
): Promise<{ ok: true; contactId: string | null } | { ok: false; error: string }> {
  if (input.assignee_id && !(await isActiveMember(admin, orgId, input.assignee_id)))
    return fail("That user is not an active member of this workspace.");
  let contactId = input.contact_id ?? null;
  if (contactId) {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("org_id", orgId)
      .eq("id", contactId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!data) return fail("That patient was not found.");
  }
  if (input.enquiry_id) {
    const { data } = await admin
      .from("enquiries")
      .select("id, contact_id")
      .eq("org_id", orgId)
      .eq("id", input.enquiry_id)
      .maybeSingle();
    if (!data) return fail("That enquiry was not found.");
    contactId = contactId ?? data.contact_id;
  }
  return { ok: true, contactId };
}

export async function createTask(
  admin: AdminClient,
  actor: Actor,
  input: CreateTaskInput,
): Promise<Result<{ id: string }>> {
  const links = await checkLinks(admin, actor.orgId, input);
  if (!links.ok) return links;
  const { data, error } = await admin
    .from("tasks")
    .insert({
      org_id: actor.orgId,
      type: input.type ?? "todo",
      subject: input.subject,
      notes: input.notes ?? null,
      due_at: input.due_at ?? null,
      assignee_id: input.assignee_id ?? null,
      contact_id: links.contactId,
      enquiry_id: input.enquiry_id ?? null,
      created_by: actor.userId,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[tasks] create failed", error?.code, redactText(error?.message));
    return fail("Could not create the task.");
  }
  if (links.contactId)
    await addTimelineEvent(admin, {
      orgId: actor.orgId,
      contactId: links.contactId,
      enquiryId: input.enquiry_id ?? null,
      type: "task.created",
      actorId: actor.userId,
      payload: { task_id: data.id, kind: input.type ?? "todo" },
    });
  await emit(actor.orgId, "task.created", {
    task_id: data.id,
    assignee_id: input.assignee_id ?? null,
  });
  if (input.assignee_id && input.assignee_id !== actor.userId)
    await createNotification(admin, {
      orgId: actor.orgId,
      userId: input.assignee_id,
      type: "task.assigned",
      title: "A task was assigned to you",
      body: input.subject,
      payload: { task_id: data.id },
    });
  return { ok: true, id: data.id };
}

export async function updateTask(
  admin: AdminClient,
  actor: Actor,
  id: string,
  patch: UpdateTaskInput,
): Promise<Result> {
  const { data: existing } = await admin
    .from("tasks")
    .select("id, assignee_id, due_at, subject")
    .eq("org_id", actor.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!existing) return fail("Task not found.");
  const links = await checkLinks(admin, actor.orgId, patch);
  if (!links.ok) return links;

  const update: Record<string, unknown> = {};
  for (const k of [
    "type",
    "subject",
    "notes",
    "due_at",
    "assignee_id",
    "contact_id",
    "enquiry_id",
  ] as const)
    if (patch[k] !== undefined) update[k] = patch[k];
  if (patch.enquiry_id && patch.contact_id === undefined && links.contactId)
    update.contact_id = links.contactId;
  // A new due time or assignee means the due notice should fire again.
  if (
    (patch.due_at !== undefined && patch.due_at !== existing.due_at) ||
    (patch.assignee_id !== undefined && patch.assignee_id !== existing.assignee_id)
  )
    update.due_notified_at = null;
  if (!Object.keys(update).length) return { ok: true };

  const { error } = await admin
    .from("tasks")
    .update(update as TablesUpdate<"tasks">)
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) {
    console.error("[tasks] update failed", error.code, redactText(error.message));
    return fail("Could not save the task.");
  }
  if (
    patch.assignee_id &&
    patch.assignee_id !== existing.assignee_id &&
    patch.assignee_id !== actor.userId
  )
    await createNotification(admin, {
      orgId: actor.orgId,
      userId: patch.assignee_id,
      type: "task.assigned",
      title: "A task was assigned to you",
      body: patch.subject ?? existing.subject,
      payload: { task_id: id },
    });
  return { ok: true };
}

export async function setTaskDone(
  admin: AdminClient,
  actor: Actor,
  id: string,
  done: boolean,
): Promise<Result> {
  const { data: t } = await admin
    .from("tasks")
    .select("id, done, contact_id, enquiry_id, type")
    .eq("org_id", actor.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!t) return fail("Task not found.");
  if (t.done === done) return { ok: true };
  const { error } = await admin
    .from("tasks")
    .update({
      done,
      done_at: done ? new Date().toISOString() : null,
      completed_by: done ? actor.userId : null,
    })
    .eq("org_id", actor.orgId)
    .eq("id", id);
  if (error) return fail("Could not update the task.");
  if (done) {
    if (t.contact_id)
      await addTimelineEvent(admin, {
        orgId: actor.orgId,
        contactId: t.contact_id,
        enquiryId: t.enquiry_id,
        type: "task.completed",
        actorId: actor.userId,
        payload: { task_id: id, kind: t.type },
      });
    await emit(actor.orgId, "task.completed", { task_id: id });
  }
  return { ok: true };
}

export async function deleteTask(
  admin: AdminClient,
  actor: Actor,
  id: string,
): Promise<Result<{ deleted: number }>> {
  const { data, error } = await admin
    .from("tasks")
    .delete()
    .eq("org_id", actor.orgId)
    .eq("id", id)
    .select("id");
  if (error) return fail("Could not delete the task.");
  return { ok: true, deleted: data?.length ?? 0 };
}

/**
 * Failed appointment reminder → one open "call patient" task per appointment (Phase 6 asked for this).
 * Idempotent: an open call task for the appointment already counts.
 */
export async function createReminderFailureTask(
  admin: AdminClient,
  orgId: string,
  args: {
    appointmentId: string;
    contactId: string | null;
    appointmentNumber: number;
    reason: string;
  },
): Promise<string | null> {
  const { data: existing } = await admin
    .from("tasks")
    .select("id")
    .eq("org_id", orgId)
    .eq("appointment_id", args.appointmentId)
    .eq("type", "call")
    .eq("done", false)
    .limit(1)
    .maybeSingle();
  if (existing) return existing.id;
  const { data, error } = await admin
    .from("tasks")
    .insert({
      org_id: orgId,
      type: "call",
      subject: `Call patient: reminder for appointment #${args.appointmentNumber} was not delivered`,
      notes: redactText(args.reason, 300),
      contact_id: args.contactId,
      appointment_id: args.appointmentId,
      due_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) {
    console.error("[tasks] reminder task failed", error.code);
    return null;
  }
  return data.id;
}
