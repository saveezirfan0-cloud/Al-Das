"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can, canAny } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  isoDate,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { lastClosedMonth, MONTH_RE } from "@/lib/finance/close-server";
import { MAX_DUE_WD, STEP_CODE_RE } from "@/lib/finance/close-timetable";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The close timetable (Phase 20G). Marking a step needs finance.close.manage (any step) or finance.close.tasks (only the
 * steps you own or back up; the database checks which). The template, the calendar and creating a month's tasks need
 * finance.close.manage. Writes use the service role after the check and are audited (ids and codes, never the text).
 */

const MANAGE = "finance.close.manage";

async function gate(perms: readonly string[]) {
  const member = await requireMember();
  return canAny(member, perms) ? member : null;
}

const refresh = () => revalidatePath("/finance/close/timetable");

/** Our own raised messages (check_violation, not allowed) are safe to show; anything else is not. */
const rpcMessage = (error: { code?: string; message: string }, fallback: string) =>
  error.code === "23514" || error.code === "42501" ? error.message : fallback;

// ---------------------------------------------------------------------------------------------------------------------
// Mark a step open / done / blocked
// ---------------------------------------------------------------------------------------------------------------------

const statusSchema = z
  .object({
    id: uuid,
    status: z.enum(["open", "done", "blocked"], { message: "Choose a status." }),
    reason: z.string().trim().max(300, "Keep the dependency under 300 characters.").default(""),
    note: z.string().trim().max(500, "Keep the note under 500 characters.").default(""),
  })
  .refine((v) => v.status !== "blocked" || v.reason !== "", {
    message: "Say what the step is waiting for (the dependency).",
  });

export async function setCloseTaskStatus(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate([MANAGE, "finance.close.tasks"]);
  if (!member) return fail(DENIED);
  const p = statusSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("fin_close_set_task_status", {
    p_org_id: member.orgId,
    p_task_id: p.data.id,
    p_user_id: member.userId,
    p_status: p.data.status,
    p_reason: p.data.reason,
    p_note: p.data.note,
    p_any_step: can(member, MANAGE),
  });
  if (error) return fail(rpcMessage(error, "The step could not be updated."));
  const r = (data ?? {}) as { month?: string; step_code?: string; from?: string; to?: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.task_status",
    entity: "fin_close_tasks",
    entityId: p.data.id,
    diff: {
      month: r.month ?? null,
      step: r.step_code ?? null,
      from: r.from ?? null,
      to: p.data.status,
    },
  });
  refresh();
  return {
    ok: true,
    message:
      p.data.status === "done"
        ? "Marked done."
        : p.data.status === "blocked"
          ? "Marked blocked."
          : "Reopened.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Create a finished month's tasks (the daily job does this from working day 1 once a start month is set)
// ---------------------------------------------------------------------------------------------------------------------

export async function createCloseTasks(raw: { month: string }): Promise<ActionResult> {
  const member = await gate([MANAGE]);
  if (!member) return fail(DENIED);
  const p = z.object({ month: z.string().regex(MONTH_RE, "Choose a month.") }).safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  if (p.data.month > lastClosedMonth(todayIn(member.org.timezone)))
    return fail("Tasks are made for a month that has ended.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("fin_close_generate_tasks", {
    p_org_id: member.orgId,
    p_month: `${p.data.month}-01`,
  });
  if (error) return fail(dbMessage(error, "The tasks could not be created."));
  const created = Number(data ?? 0);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.tasks_created",
    entity: "fin_close_tasks",
    entityId: member.orgId,
    diff: { month: p.data.month, created },
  });
  refresh();
  return {
    ok: true,
    message:
      created > 0
        ? `${created} step(s) added to the month.`
        : "Nothing to add: the month already has every active step, or it is locked.",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The checklist template
// ---------------------------------------------------------------------------------------------------------------------

const person = z.union([uuid, z.literal("")]).default("");

const stepSchema = z
  .object({
    code: z
      .string()
      .trim()
      .transform((v) => v.toUpperCase())
      .refine((v) => STEP_CODE_RE.test(v), {
        message: "Code: 1 to 24 capital letters, digits or _.",
      }),
    title: z
      .string()
      .trim()
      .min(1, "Give the step a title.")
      .max(120, "Title: at most 120 characters."),
    owner_role: z.string().trim().max(60, "Role: at most 60 characters.").default(""),
    owner_user_id: person,
    backup_user_id: person,
    due_wd: z.coerce
      .number({ message: "Due working day must be a number." })
      .int("Due working day must be a whole number.")
      .min(1, "Due working day: 1 to 23.")
      .max(MAX_DUE_WD, "Due working day: 1 to 23."),
    evidence_hint: z.string().trim().max(200, "Evidence: at most 200 characters.").default(""),
    active: z.string().optional(),
    sort_order: z.coerce
      .number({ message: "Order must be a number." })
      .int("Order must be a whole number.")
      .min(0)
      .max(10000)
      .default(100),
  })
  .refine((v) => !v.owner_user_id || v.owner_user_id !== v.backup_user_id, {
    message: "The backup must be a different person from the owner.",
  });

/** Field names: the step's columns, plus one `dep_<CODE>` checkbox per step it depends on. */
export async function saveCloseStep(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate([MANAGE]);
  if (!member) return fail(DENIED);
  const p = stepSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const deps = [
    ...new Set(
      Object.keys(values)
        .filter((k) => k.startsWith("dep_") && values[k] === "on")
        .map((k) => k.slice(4)),
    ),
  ];
  if (deps.length > 10) return fail("A step can depend on at most 10 others.");
  if (deps.some((d) => !STEP_CODE_RE.test(d) || d === v.code))
    return fail("A step cannot depend on itself.");

  const admin = createAdminClient(member.userId);
  const people = [v.owner_user_id, v.backup_user_id].filter((x) => x !== "");
  if (people.length > 0) {
    const { data: m } = await admin
      .from("memberships")
      .select("user_id")
      .eq("org_id", member.orgId)
      .eq("status", "active")
      .in("user_id", people);
    if ((m ?? []).length !== new Set(people).size)
      return fail("Choose active members of this workspace.");
  }
  if (deps.length > 0) {
    const { data: known } = await admin
      .from("fin_close_steps")
      .select("code")
      .eq("org_id", member.orgId)
      .in("code", deps);
    if ((known ?? []).length !== deps.length)
      return fail("A dependency is not a step of this checklist.");
  }
  const { error } = await admin.from("fin_close_steps").upsert(
    {
      org_id: member.orgId,
      code: v.code,
      title: v.title,
      owner_role: v.owner_role || null,
      owner_user_id: v.owner_user_id || null,
      backup_user_id: v.backup_user_id || null,
      due_wd: v.due_wd,
      depends_on: deps,
      evidence_hint: v.evidence_hint || null,
      active: v.active === "on",
      sort_order: v.sort_order,
    },
    { onConflict: "org_id,code" },
  );
  if (error) return fail(dbMessage(error, "Could not save the step."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.step_saved",
    entity: "fin_close_steps",
    entityId: member.orgId,
    diff: {
      code: v.code,
      due_wd: v.due_wd,
      owner: v.owner_user_id || null,
      backup: v.backup_user_id || null,
      depends_on: deps,
      active: v.active === "on",
    },
  });
  refresh();
  return {
    ok: true,
    message: `Step ${v.code} saved. A new due day applies to months whose tasks are created from now on.`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The working-day calendar and the measures
// ---------------------------------------------------------------------------------------------------------------------

const wd = (label: string) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .int(`${label} must be a whole number.`)
    .min(1, `${label}: 1 to 23.`)
    .max(MAX_DUE_WD, `${label}: 1 to 23.`);

const calendarSchema = z
  .object({
    start: z
      .string()
      .trim()
      .refine(
        (x) => x === "" || MONTH_RE.test(x),
        "Choose a month, or leave it blank to keep the timetable off.",
      )
      .transform((x) => (x === "" ? null : `${x}-01`)),
    inputs_wd: wd("Inputs working day"),
    deadline_wd: wd("Delivery working day"),
    item_max_age_days: z.coerce
      .number({ message: "Age limit must be a number." })
      .int("Age limit must be a whole number.")
      .min(1, "Age limit: 1 to 365 days.")
      .max(365, "Age limit: 1 to 365 days."),
  })
  .refine((x) => x.inputs_wd <= x.deadline_wd, {
    message: "Inputs are due on or before the delivery working day.",
  });

/** Field names: start (YYYY-MM or blank = off), inputs_wd, deadline_wd, item_max_age_days and wk_1..wk_7 checkboxes. */
export async function saveCloseCalendar(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate([MANAGE]);
  if (!member) return fail(DENIED);
  const p = calendarSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const weekend = [1, 2, 3, 4, 5, 6, 7].filter((d) => values[`wk_${d}`] === "on");
  if (weekend.length > 6) return fail("Leave at least one working day in the week.");
  const admin = createAdminClient(member.userId);
  const row = {
    close_timetable_start: p.data.start,
    close_weekend_days: weekend,
    close_inputs_wd: p.data.inputs_wd,
    close_deadline_wd: p.data.deadline_wd,
    close_item_max_age_days: p.data.item_max_age_days,
  };
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, ...row }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the calendar."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.calendar_saved",
    entity: "fin_ref_finance_settings",
    entityId: member.orgId,
    diff: row,
  });
  refresh();
  return {
    ok: true,
    message: p.data.start
      ? "Saved. The daily job runs the timetable."
      : "Saved. The timetable job is off.",
  };
}

const holidaySchema = z.object({
  holiday_on: isoDate,
  name: z.string().trim().min(1, "Name the holiday.").max(80, "Name: at most 80 characters."),
});

export async function addHoliday(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate([MANAGE]);
  if (!member) return fail(DENIED);
  const p = holidaySchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_holidays")
    .insert({ org_id: member.orgId, ...p.data, created_by: member.userId })
    .select("id")
    .single();
  if (error)
    return fail(
      error.code === "23505"
        ? "That date is already a holiday."
        : dbMessage(error, "Could not add the holiday."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.holiday_added",
    entity: "fin_ref_holidays",
    entityId: data.id,
    diff: { holiday_on: p.data.holiday_on },
  });
  refresh();
  return { ok: true, message: "Holiday added." };
}

export async function deleteHoliday(raw: { id: string }): Promise<ActionResult> {
  const member = await gate([MANAGE]);
  if (!member) return fail(DENIED);
  const p = z.object({ id: uuid }).safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_ref_holidays")
    .delete()
    .eq("org_id", member.orgId)
    .eq("id", p.data.id)
    .select("holiday_on");
  if (error || !data?.length) return fail(dbMessage(error, "Could not remove the holiday."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.close.holiday_removed",
    entity: "fin_ref_holidays",
    entityId: p.data.id,
    diff: { holiday_on: data[0].holiday_on },
  });
  refresh();
  return { ok: true, message: "Holiday removed." };
}
