"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import {
  DENIED,
  dbMessage,
  fail,
  firstIssue,
  todayIn,
  type ActionResult,
} from "@/lib/finance/action-support";
import { AREAS, AREA_LABEL, AREA_VIEW_KEY } from "@/lib/finance/parallel-run";
import { loadParallelView } from "@/lib/finance/parallel-run-server";
import { shiftMonth } from "@/lib/finance/report-emails";
import { redactStatementText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Parallel run (W4). Typing in a manual figure, setting the tolerance and recording the decision all need
 * finance.parallel_run.manage AND the area's own report key (so nobody records a figure for an area they cannot see).
 * Writes use the service role after the check and are audited with the area and month only, never the amount or the
 * note. Nothing here posts to the books.
 */

/** The manage key. A function declaration so `pnpm audit:security` can see the action is guarded. */
async function gate() {
  const member = await requireMember();
  return can(member, "finance.parallel_run.manage") ? member : null;
}

const area = z.enum(AREAS, { message: "Choose an area." });
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Choose a month.");
const note = z.string().max(500, "Keep the note under 500 characters.");
const refresh = () => revalidatePath("/finance/parallel-run");

export async function saveManualFigure(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = z
    .object({
      area,
      month,
      amount: z
        .string()
        .trim()
        .regex(/^-?\d{1,10}(\.\d{1,3})?$/, "Enter the amount in AED, up to three decimals."),
      note: note.optional(),
    })
    .safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  if (!can(member, AREA_VIEW_KEY[v.area])) return fail(DENIED);
  // finished months only: the current month is not complete, so there is nothing to compare yet
  const last = shiftMonth(todayIn(member.org.timezone).slice(0, 7), -1);
  if (v.month > last) return fail("Only finished months can be compared.");

  const admin = createAdminClient(member.userId); // service role AFTER the permission checks
  const { error } = await admin.from("fin_parallel_figures").upsert(
    {
      org_id: member.orgId,
      area: v.area,
      month: `${v.month}-01`,
      manual_amount: Number(v.amount),
      note: redactStatementText(v.note ?? "", 500),
      entered_by: member.userId,
      entered_at: new Date().toISOString(),
    },
    { onConflict: "org_id,area,month" },
  );
  if (error) return fail(dbMessage(error, "Could not save the figure."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.parallel_run.figure_saved",
    entity: "fin_parallel_figures",
    diff: { area: v.area, month: v.month },
  });
  refresh();
  return { ok: true, message: `${AREA_LABEL[v.area]} for ${v.month} saved.` };
}

export async function saveTolerance(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = z
    .string()
    .trim()
    .regex(/^\d{1,5}(\.\d{1,3})?$/, "Enter an amount in AED, up to three decimals.")
    .safeParse(values.tolerance ?? "");
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const amount = Number(parsed.data);
  if (amount > 10000) return fail("The tolerance cannot be more than 10,000.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_finance_settings")
    .upsert({ org_id: member.orgId, parallel_tolerance: amount }, { onConflict: "org_id" });
  if (error) return fail(dbMessage(error, "Could not save the tolerance."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.parallel_run.tolerance_saved",
    entity: "fin_ref_finance_settings",
    diff: { field: "parallel_tolerance" },
  });
  refresh();
  return { ok: true, message: "Tolerance saved." };
}

/**
 * Records the decision for one area. "switched" is accepted only when the area's two latest months agree, worked out
 * HERE from the stored manual figures and Pulse's live figures, never taken from the browser. Going back to "running" is
 * always allowed. A later disagreement never changes the decision by itself; the page shows a warning.
 */
export async function setDecision(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = z
    .object({ area, status: z.enum(["running", "switched"]), note: note.optional() })
    .safeParse(values);
  if (!parsed.success) return fail(firstIssue(parsed.error));
  const v = parsed.data;
  if (!can(member, AREA_VIEW_KEY[v.area])) return fail(DENIED);

  const admin = createAdminClient(member.userId);
  if (v.status === "switched") {
    const view = await loadParallelView(admin, member, todayIn(member.org.timezone));
    const a = view.areas.find((x) => x.area === v.area);
    if (!a) return fail(DENIED);
    if (!a.check.ok) return fail(`Not yet: ${a.check.reason}`);
  }
  const { error } = await admin.from("fin_parallel_decisions").upsert(
    {
      org_id: member.orgId,
      area: v.area,
      status: v.status,
      note: redactStatementText(v.note ?? "", 500),
      decided_by: member.userId,
      decided_at: new Date().toISOString(),
    },
    { onConflict: "org_id,area" },
  );
  if (error) return fail(dbMessage(error, "Could not record the decision."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.parallel_run.decision_recorded",
    entity: "fin_parallel_decisions",
    diff: { area: v.area, status: v.status },
  });
  refresh();
  return {
    ok: true,
    message:
      v.status === "switched"
        ? `${AREA_LABEL[v.area]} is marked as switched to Pulse.`
        : `${AREA_LABEL[v.area]} is back to running in parallel.`,
  };
}
