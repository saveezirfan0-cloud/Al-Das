"use server";

import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { searchTerm } from "@/lib/enquiries/filter";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { createAdminClient } from "@/lib/supabase/admin";
import { createTaskSchema, taskFilterSchema, updateTaskSchema } from "@/lib/tasks/schemas";
import * as service from "@/lib/tasks/service";
import type { TaskRow } from "@/lib/tasks/types";

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

const uuid = z.string().uuid();
const bad = (error = "Invalid input"): { ok: false; error: string } => ({ ok: false, error });

export async function loadTasks(input: {
  filter: z.input<typeof taskFilterSchema>;
  page: number;
}): Promise<ActionResult<{ rows: TaskRow[]; total: number; pageSize: number }>> {
  const member = await requirePerm("tasks.manage");
  const filter = taskFilterSchema.safeParse(input.filter);
  if (!filter.success || !Number.isInteger(input.page) || input.page < 0 || input.page > 10_000)
    return bad();
  const res = await service.listTasks(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    filter.data,
    input.page,
  );
  return { ok: true, ...res, pageSize: service.TASK_PAGE_SIZE };
}

export async function createTaskAction(
  input: z.input<typeof createTaskSchema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await requirePerm("tasks.manage");
  const parsed = createTaskSchema.safeParse(input);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message);
  return service.createTask(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    parsed.data,
  );
}

export async function updateTaskAction(
  id: string,
  patch: z.input<typeof updateTaskSchema>,
): Promise<ActionResult> {
  const member = await requirePerm("tasks.manage");
  const parsed = updateTaskSchema.safeParse(patch);
  if (!uuid.safeParse(id).success || !parsed.success)
    return bad(parsed.success ? undefined : parsed.error.issues[0]?.message);
  return service.updateTask(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    id,
    parsed.data,
  );
}

export async function setTaskDoneAction(id: string, done: boolean): Promise<ActionResult> {
  const member = await requirePerm("tasks.manage");
  if (!uuid.safeParse(id).success) return bad();
  return service.setTaskDone(
    createAdminClient(),
    { orgId: member.orgId, userId: member.userId },
    id,
    done,
  );
}

export async function deleteTaskAction(id: string): Promise<ActionResult> {
  const member = await requirePerm("tasks.manage");
  if (!uuid.safeParse(id).success) return bad();
  const admin = createAdminClient();
  const res = await service.deleteTask(admin, { orgId: member.orgId, userId: member.userId }, id);
  if (res.ok && res.deleted > 0)
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "task.deleted",
      entity: "task",
      entityId: id,
    });
  return res.ok ? { ok: true } : res;
}

export type PatientOption = { id: string; name: string; phone: string | null };

/** Patient picker for the task form. Needs contacts.view as well: it returns names and phones. */
export async function searchPatients(
  term: string,
): Promise<ActionResult<{ patients: PatientOption[] }>> {
  const member = await requirePerm("tasks.manage");
  if (!can(member, "contacts.view")) return bad("You cannot search patients.");
  const t = searchTerm(term.slice(0, 100));
  if (t.length < 2) return { ok: true, patients: [] };
  const digits = t.replace(/\D/g, "");
  const parts = [
    `first_name.ilike.%${t}%`,
    `last_name.ilike.%${t}%`,
    `wa_profile_name.ilike.%${t}%`,
  ];
  if (digits.length >= 4) parts.push(`phone_e164.ilike.%${digits}%`);
  const { data } = await createAdminClient()
    .from("contacts")
    .select("id, first_name, last_name, wa_profile_name, phone_e164")
    .eq("org_id", member.orgId)
    .is("deleted_at", null)
    .or(parts.join(","))
    .limit(20);
  return {
    ok: true,
    patients: (data ?? []).map((c) => ({
      id: c.id,
      name: contactDisplayName(c),
      phone: c.phone_e164,
    })),
  };
}

/** Looks an enquiry up by its number ("#123"), for linking a task to it. */
export async function enquiryByNumber(
  n: number,
): Promise<
  ActionResult<{ enquiry: { id: string; number: number; contact_id: string | null } | null }>
> {
  const member = await requirePerm("tasks.manage");
  if (!can(member, "enquiries.view")) return bad("You cannot look up enquiries.");
  if (!Number.isInteger(n) || n < 1 || n > 1_000_000_000) return { ok: true, enquiry: null };
  const { data } = await createAdminClient()
    .from("enquiries")
    .select("id, number, contact_id")
    .eq("org_id", member.orgId)
    .eq("number", n)
    .maybeSingle();
  return {
    ok: true,
    enquiry: data
      ? { id: data.id, number: Number(data.number), contact_id: data.contact_id }
      : null,
  };
}
