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
  isoDate,
  todayIn,
  uuid,
  type ActionResult,
} from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * End-of-day cash-up per branch. Every action needs finance.cashup.manage. The expected amounts come from the payments Pulse
 * holds for that branch and day; the cashier enters what was counted. A submitted cash-up is frozen until it is reopened, and
 * a cash-up in a locked month can never change (database triggers).
 */

const PERM = "finance.cashup.manage";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const openSchema = z.object({
  branch: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,4}$/, "Choose a branch."),
  date: isoDate,
});

/** Starts (or reopens the draft of) the cash-up for a branch and day and fills in what the system expects. */
export async function openCashup(raw: {
  branch: string;
  date: string;
}): Promise<ActionResult<{ id: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = openSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const branch = p.data.branch.toUpperCase();
  if (p.data.date > todayIn(member.org.timezone))
    return fail("You cannot cash up a day that has not happened yet.");
  const admin = createAdminClient(member.userId);
  const { data: b } = await admin
    .from("fin_ref_branches")
    .select("code")
    .eq("org_id", member.orgId)
    .eq("code", branch)
    .eq("active", true)
    .maybeSingle();
  if (!b) return fail("That branch is not set up.");
  let { data: existing } = await admin
    .from("fin_cashups")
    .select("id, status")
    .eq("org_id", member.orgId)
    .eq("branch_code", branch)
    .eq("business_date", p.data.date)
    .maybeSingle();
  if (!existing) {
    const { data, error } = await admin
      .from("fin_cashups")
      .insert({
        org_id: member.orgId,
        branch_code: branch,
        business_date: p.data.date,
        prepared_by: member.userId,
      })
      .select("id, status")
      .single();
    if (error || !data) return fail(dbMessage(error, "Could not start the cash-up."));
    existing = data;
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.cashup.started",
      entity: "fin_cashups",
      entityId: data.id,
      diff: { branch, date: p.data.date },
    });
  }
  if (existing.status === "draft") {
    const { error } = await admin.rpc("fin_cashup_refresh", {
      p_org_id: member.orgId,
      p_cashup_id: existing.id,
    });
    if (error) return fail("Could not load the expected amounts.");
  }
  revalidatePath("/finance/cashup");
  return { ok: true, data: { id: existing.id } };
}

const linesSchema = z.object({
  id: uuid,
  note: z.string().trim().max(500).default(""),
  lines: z
    .array(
      z.object({
        mode: z.string().trim().min(1).max(60),
        counted: z.number().min(0).max(1e9).nullable(),
        reason: z.string().trim().max(200).default(""),
      }),
    )
    .max(30),
});

/** Saves what was counted (a draft only). A payment mode the system did not expect can be added: its expectation is 0. */
export async function saveCashupCounts(raw: z.input<typeof linesSchema>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = linesSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data: cashup } = await admin
    .from("fin_cashups")
    .select("status")
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .maybeSingle();
  if (!cashup) return fail("That cash-up was not found.");
  if (cashup.status !== "draft") return fail("A submitted cash-up is frozen. Reopen it first.");
  for (const l of p.data.lines) {
    const { error } = await admin.from("fin_cashup_lines").upsert(
      {
        org_id: member.orgId,
        cashup_id: p.data.id,
        payment_mode: l.mode,
        counted_amount: l.counted,
        reason: l.reason || null,
      },
      { onConflict: "cashup_id,payment_mode" },
    );
    if (error) return fail(dbMessage(error, "Could not save the counts."));
  }
  await admin
    .from("fin_cashups")
    .update({ note: p.data.note || null })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.cashup.counted",
    entity: "fin_cashups",
    entityId: p.data.id,
    diff: { modes: p.data.lines.length },
  });
  revalidatePath("/finance/cashup");
  return { ok: true, message: "Counts saved." };
}

export async function submitCashup(id: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid cash-up.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin.rpc("fin_cashup_submit", {
    p_org_id: member.orgId,
    p_cashup_id: id,
    p_user_id: member.userId,
  });
  if (error)
    return fail(
      error.code === "23514" ? error.message : dbMessage(error, "Could not submit the cash-up."),
    );
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.cashup.submitted",
    entity: "fin_cashups",
    entityId: id,
  });
  revalidatePath("/finance/cashup");
  return { ok: true, message: "Cash-up submitted." };
}

export async function reopenCashup(id: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(id).success) return fail("Invalid cash-up.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("fin_cashups")
    .update({ status: "draft", submitted_at: null, submitted_by: null })
    .eq("id", id)
    .eq("org_id", member.orgId)
    .eq("status", "submitted")
    .select("id");
  if (error || !data?.length) return fail(dbMessage(error, "Could not reopen the cash-up."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.cashup.reopened",
    entity: "fin_cashups",
    entityId: id,
  });
  revalidatePath("/finance/cashup");
  return { ok: true, message: "Reopened. Submit it again when you have corrected it." };
}
