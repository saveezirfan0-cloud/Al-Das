"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, dbMessage, fail, type ActionResult } from "@/lib/finance/action-support";
import {
  parseCompensation,
  parseMonth,
  parseOverheads,
  parseServiceCosts,
  type CostKind,
} from "@/lib/finance/cost-upload";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Cost inputs. Service costs and overheads need finance.costs.manage; doctor compensation needs its own, more
 * confidential finance.costs.compensation; approving or reopening a month needs finance.profit.approve. A file is saved
 * whole or not at all (fin_cost_upsert is one transaction), and every change is audited.
 */

const MAX_CHARS = 1_500_000;
const KINDS: readonly CostKind[] = ["services", "compensation", "overheads"];
const permFor = (k: CostKind) =>
  k === "compensation" ? "finance.costs.compensation" : "finance.costs.manage";
const refresh = () => {
  revalidatePath("/finance/costs");
  revalidatePath("/finance/profitability");
};

export async function uploadCosts(
  kind: string,
  csv: string,
): Promise<ActionResult<{ rows: number }>> {
  const member = await requireMember();
  if (!(KINDS as readonly string[]).includes(kind)) return fail("Choose what you are uploading.");
  const k = kind as CostKind;
  if (!can(member, permFor(k))) return fail(DENIED);
  if (typeof csv !== "string" || csv.trim() === "") return fail("The file is empty.");
  if (csv.length > MAX_CHARS) return fail("The file is too large. Split it into smaller files.");

  const parsed =
    k === "services"
      ? parseServiceCosts(csv)
      : k === "compensation"
        ? parseCompensation(csv)
        : parseOverheads(csv);
  if (!parsed.ok) return fail(`Nothing was saved. ${parsed.errors.slice(0, 6).join(" ")}`);

  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { error } = await admin.rpc("fin_cost_upsert", {
    p_org_id: member.orgId,
    p_kind: k,
    p_rows: parsed.rows as unknown as Json,
    p_user: member.userId,
  });
  if (error) return fail(dbMessage(error, "Nothing was saved. Check the file and try again."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `finance.costs.${k}_uploaded`,
    entity:
      "fin_cost_" +
      (k === "services" ? "services" : k === "compensation" ? "doctor_comp" : "overheads"),
    entityId: member.orgId,
    diff: { rows: parsed.rows.length },
  });
  refresh();
  return {
    ok: true,
    data: { rows: parsed.rows.length },
    message: `${parsed.rows.length} rows saved.`,
  };
}

export async function setCostMonth(
  month: string,
  status: string,
  note = "",
): Promise<ActionResult> {
  const member = await requireMember();
  if (!can(member, "finance.profit.approve")) return fail(DENIED);
  const m = parseMonth(month);
  if (!m) return fail("Choose a month.");
  if (status !== "approved" && status !== "draft") return fail("Choose approve or reopen.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_cost_set_period", {
    p_org_id: member.orgId,
    p_month: m,
    p_status: status,
    p_user: member.userId,
    p_note: note.trim().slice(0, 500),
  });
  if (error) return fail(dbMessage(error, "Could not change the month."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: status === "approved" ? "finance.costs.month_approved" : "finance.costs.month_reopened",
    entity: "fin_cost_periods",
    entityId: member.orgId,
    diff: { month: m },
  });
  refresh();
  return { ok: true, message: status === "approved" ? "Month approved." : "Month reopened." };
}
