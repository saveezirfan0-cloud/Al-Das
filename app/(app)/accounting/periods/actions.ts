"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  fail,
  firstIssue,
  isoDate,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Accounting periods (Phase 22A), accounting.periods.manage. Open <-> closed; closed -> locked is final (the typed word
 * LOCK confirms it). The database (acc_set_period_status) checks the permission and the order again. Audited.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const statusSchema = z.object({
  id: uuid,
  status: z.enum(["open", "closed", "locked"]),
  confirm: z.string().trim().default(""),
});

export async function setPeriodStatus(raw: z.input<typeof statusSchema>): Promise<ActionResult> {
  const member = await gate("accounting.periods.manage");
  if (!member) return fail(DENIED);
  const p = statusSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  if (p.data.status === "locked" && p.data.confirm !== "LOCK")
    return fail("Type LOCK to lock the period. A locked period can never be opened again.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_set_period_status", {
    p_org_id: member.orgId,
    p_period_id: p.data.id,
    p_user_id: member.userId,
    p_status: p.data.status,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The period could not be changed."));
  const r = data as { from: string; to: string; year: number; month: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `accounting.period.${p.data.status === "open" ? "reopened" : p.data.status}`,
    entity: "acc_periods",
    entityId: p.data.id,
    diff: { from: r.from, to: r.to, year: r.year, month: r.month },
  });
  revalidatePath("/accounting/periods");
  revalidatePath("/accounting/dashboard");
  return { ok: true, message: `Period ${p.data.status === "open" ? "reopened" : p.data.status}.` };
}

const createSchema = z.object({
  date: isoDate,
  entity_id: z.union([uuid, z.literal("")]).default(""),
});

/** Creates the period (and its fiscal year) for a date ahead of the first posting, so it can be closed or locked. */
export async function createPeriod(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.periods.manage");
  if (!member) return fail(DENIED);
  const p = createSchema.safeParse(values);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  let entityId = p.data.entity_id;
  if (!entityId) {
    const { data } = await admin
      .from("acc_entities")
      .select("id")
      .eq("org_id", member.orgId)
      .eq("is_default", true)
      .maybeSingle();
    entityId = data?.id ?? "";
  }
  if (!entityId) return fail("Set up the entity first.");
  const { data, error } = await admin.rpc("acc_ensure_period", {
    p_org_id: member.orgId,
    p_entity_id: entityId,
    p_date: p.data.date,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The period could not be created."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.period.created",
    entity: "acc_periods",
    entityId: data as string,
    diff: { date: p.data.date },
  });
  revalidatePath("/accounting/periods");
  return { ok: true, message: "Period ready." };
}
