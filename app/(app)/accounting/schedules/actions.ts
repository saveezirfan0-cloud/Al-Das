"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { assetErrorMessage } from "@/lib/accounting/assets/errors";
import { defaultEntityId } from "@/lib/accounting/assets/server";
import { cleanDescription } from "@/lib/accounting/journal";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  optionalAmount,
  optionalInt,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Prepayment, accrual and deferred revenue schedules (Phase 22H), accounting.assets.manage. The releases are posted by
 * the monthly runs (../depreciation/actions.ts). The database checks the ledgers fit the kind and locks the figures once a
 * release is posted (cancel and re-enter instead). Audited (ids, kinds and amounts only).
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

function refresh() {
  revalidatePath("/accounting/schedules");
}

const optionalId = z.union([uuid, z.literal("")]).default("");

const scheduleSchema = z.object({
  id: optionalId,
  kind: z.enum(["prepayment", "accrual", "deferred_revenue"]),
  description: z.string().trim().min(1, "Describe the schedule.").max(400),
  pl_account_id: uuid,
  bs_account_id: uuid,
  total: optionalAmount,
  start_month: z
    .string()
    .trim()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose the first month."),
  months: optionalInt(600),
  branch_code: z.string().trim().max(20).default(""),
  department: z.string().trim().max(60).default(""),
  auto_reverse: z.string().optional(),
  supplier_invoice_id: optionalId,
});

export async function saveSchedule(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  const p = scheduleSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  if (!v.total || v.total <= 0) return fail("Enter the total.");
  if (!v.months || v.months < 1) return fail("Spread it over 1 to 600 months.");
  const description = cleanDescription(v.description);
  if (!description) return fail("Describe the schedule.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const row = {
    kind: v.kind,
    description,
    pl_account_id: v.pl_account_id,
    bs_account_id: v.bs_account_id,
    total: v.total,
    start_month: `${v.start_month}-01`,
    months: v.months,
    branch_code: v.branch_code.toUpperCase() || null,
    department: v.department || null,
    auto_reverse: v.kind === "accrual" && v.auto_reverse === "on",
    supplier_invoice_id: v.supplier_invoice_id || null,
  };
  let id = v.id;
  if (v.id) {
    const { error } = await admin
      .from("acc_schedules")
      .update(row)
      .eq("id", v.id)
      .eq("org_id", member.orgId);
    if (error) return fail(assetErrorMessage(error, "The schedule could not be saved."));
  } else {
    const entityId = await defaultEntityId(admin, member.orgId);
    if (!entityId) return fail("Set up the accounting entity first.");
    const { data, error } = await admin
      .from("acc_schedules")
      .insert({ ...row, org_id: member.orgId, entity_id: entityId, created_by: member.userId })
      .select("id")
      .single();
    if (error || !data) return fail(assetErrorMessage(error, "The schedule could not be saved."));
    id = data.id;
  }
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.schedule.updated" : "accounting.schedule.created",
    entity: "acc_schedules",
    entityId: id,
    diff: { kind: row.kind, total: row.total, months: row.months, start_month: row.start_month },
  });
  refresh();
  return { ok: true, message: "Schedule saved." };
}

/** Cancel (stops further releases; what was released stays) or delete (only before any release). */
export async function scheduleStep(input: {
  id: string;
  action: "cancel" | "delete";
}): Promise<ActionResult> {
  const member = await gate("accounting.assets.manage");
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(input.id).success || !["cancel", "delete"].includes(input.action))
    return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId);
  const { error } =
    input.action === "cancel"
      ? await admin
          .from("acc_schedules")
          .update({ status: "cancelled" })
          .eq("id", input.id)
          .eq("org_id", member.orgId)
      : await admin.from("acc_schedules").delete().eq("id", input.id).eq("org_id", member.orgId);
  if (error) return fail(assetErrorMessage(error, "That did not work."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action:
      input.action === "cancel" ? "accounting.schedule.cancelled" : "accounting.schedule.deleted",
    entity: "acc_schedules",
    entityId: input.id,
  });
  refresh();
  return {
    ok: true,
    message: input.action === "cancel" ? "Schedule cancelled." : "Schedule deleted.",
  };
}
