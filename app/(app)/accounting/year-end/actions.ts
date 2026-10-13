"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { cleanNarration } from "@/lib/accounting/journal";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, uuid, type ActionResult } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Year-end close (Phase 22I), accounting.periods.manage. Closing posts the closing journal (income and expenses to
 * retained earnings) and closes the year, which then refuses every posting; re-opening reverses that journal, with a
 * reason. Both need a typed word. The database checks the permission and every precondition again. Audited.
 */

const PERM = "accounting.periods.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const refresh = () => {
  revalidatePath("/accounting/year-end");
  revalidatePath("/accounting/periods");
  revalidatePath("/accounting/trial-balance");
};

export async function closeYearMonths(id: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Reload the page and try again.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_year_end_close_months", {
    p_org_id: member.orgId,
    p_fiscal_year_id: id,
    p_user_id: member.userId,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The months could not be closed."));
  const r = data as { closed: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.year_end.months_closed",
    entity: "acc_fiscal_years",
    entityId: id,
    diff: { closed: r.closed },
  });
  refresh();
  return { ok: true, message: `${r.closed} month(s) closed.` };
}

const closeSchema = z.object({ id: uuid, confirm: z.string().trim().default("") });

export async function closeYear(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = closeSchema.safeParse(values);
  if (!p.success) return fail("Reload the page and try again.");
  if (p.data.confirm !== "CLOSE") return fail("Type CLOSE to close the year.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_year_end_close", {
    p_org_id: member.orgId,
    p_fiscal_year_id: p.data.id,
    p_user_id: member.userId,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The year could not be closed."));
  const r = data as {
    label: string;
    number: string | null;
    result: number;
    lines: number;
    journal_id: string | null;
  };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.year_end.closed",
    entity: "acc_fiscal_years",
    entityId: p.data.id,
    diff: { journal_id: r.journal_id, number: r.number, result: r.result, lines: r.lines },
  });
  refresh();
  return { ok: true, message: `${r.label} closed${r.number ? ` (${r.number})` : ""}.` };
}

const reopenSchema = z.object({
  id: uuid,
  confirm: z.string().trim().default(""),
  reason: z.string().trim().min(3, "Say why the year is re-opened.").max(200),
});

export async function reopenYear(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = reopenSchema.safeParse(values);
  if (!p.success) return fail(p.error.issues[0]?.message ?? "Check the form and try again.");
  if (p.data.confirm !== "REOPEN") return fail("Type REOPEN to re-open the year.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_year_end_reopen", {
    p_org_id: member.orgId,
    p_fiscal_year_id: p.data.id,
    p_user_id: member.userId,
    p_reason: cleanNarration(p.data.reason) ?? "",
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The year could not be re-opened."));
  const r = data as { label: string; reversal_id: string | null; reversal_number: string | null };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.year_end.reopened",
    entity: "acc_fiscal_years",
    entityId: p.data.id,
    diff: { reversal_id: r.reversal_id, number: r.reversal_number },
  });
  refresh();
  return { ok: true, message: `${r.label} re-opened.` };
}
