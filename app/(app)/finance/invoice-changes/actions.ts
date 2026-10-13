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
  type ActionResult,
} from "@/lib/finance/action-support";
import {
  bulkEligible,
  CHANGE_KINDS,
  DECISIONS,
  periodProblem,
  REASON_MAX,
} from "@/lib/finance/invoice-changes";
import { loadChanges } from "@/lib/finance/invoice-changes-server";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Invoice-change review (Phase 20J). A decision on a Unite invoice change needs finance.changes.review. The change is
 * never taken from the browser: the action re-reads the register for the change's date and acts only on a change it
 * finds there with that key, so the kind, amount, invoice and lock flag recorded are Pulse's own. The reason is free text:
 * it is required, capped and passed through redactText (numbers and e-mail addresses masked); the audit row records THAT
 * a reason was given, never its text. Nothing here writes to Unite or changes an invoice: a review is evidence only.
 */

const PERM = "finance.changes.review";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const reason = z
  .string()
  .trim()
  .min(1, "Give a reason.")
  .max(REASON_MAX, `Keep the reason under ${REASON_MAX} characters.`);
const cleanReason = (text: string) => redactText(text, REASON_MAX).slice(0, REASON_MAX).trim();
const READ_FAILED = "Could not read the invoice changes. Try again.";

const reviewSchema = z.object({
  change_key: z.string().regex(/^[0-9a-f]{32}$/, "That change was not found."),
  change_date: isoDate,
  decision: z.enum(DECISIONS, { message: "Choose a decision." }),
  reason,
});

export async function reviewChange(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = reviewSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the form."));
  const d = p.data;

  const admin = createAdminClient(member.userId);
  const reg = await loadChanges(admin, member.orgId, d.change_date, d.change_date).catch(
    () => null,
  );
  if (!reg) return fail(READ_FAILED);
  const e = reg.events.find((x) => x.changeKey === d.change_key);
  if (!e) return fail("That change was not found; it may have changed since the page loaded.");
  if (e.review) return fail("This change has already been reviewed.");
  const text = cleanReason(d.reason);
  if (!text) return fail("Give a reason.");

  const { error } = await admin.from("fin_invoice_change_reviews").insert({
    org_id: member.orgId,
    change_key: e.changeKey,
    invoice_id: e.invoiceId,
    kind: e.kind,
    amount: e.amount,
    change_date: e.changeDate,
    decision: d.decision,
    reason: text,
    month_locked: e.monthLocked,
    reviewed_by: member.userId,
  });
  if (error)
    return fail(
      error.code === "23505"
        ? "This change has already been reviewed."
        : dbMessage(error, "Could not save the review."),
    );

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.invoice_change.reviewed",
    entity: "fin_invoices",
    entityId: e.invoiceId,
    diff: {
      change_key: e.changeKey,
      kind: e.kind,
      amount: e.amount,
      decision: d.decision,
      month_locked: e.monthLocked,
      reason: true,
    },
  });
  revalidatePath("/finance/invoice-changes");
  return { ok: true, message: "Review saved." };
}

const bulkSchema = z.object({
  from: isoDate,
  to: isoDate,
  kind: z
    .string()
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || (CHANGE_KINDS as readonly string[]).includes(v), "Choose a kind."),
  reason,
});

/** Approves every unreviewed change in the period (optionally of one kind) up to the bulk maximum Finance has set. */
export async function bulkApproveChanges(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = bulkSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error, "Check the form."));
  const d = p.data;
  const bad = periodProblem(d.from, d.to);
  if (bad) return fail(bad);

  const admin = createAdminClient(member.userId);
  const reg = await loadChanges(admin, member.orgId, d.from, d.to).catch(() => null);
  if (!reg) return fail(READ_FAILED);
  if (!(reg.bulkMax > 0))
    return fail("Bulk approval is off. Finance sets its limit in Workflow settings.");
  const picked = bulkEligible(
    reg.events,
    reg.bulkMax,
    d.kind as (typeof CHANGE_KINDS)[number] | null,
  );
  if (picked.length === 0)
    return fail("No unreviewed changes up to the bulk limit in this period.");
  const text = cleanReason(d.reason);
  if (!text) return fail("Give a reason.");

  const { data: saved, error } = await admin
    .from("fin_invoice_change_reviews")
    .upsert(
      picked.map((e) => ({
        org_id: member.orgId,
        change_key: e.changeKey,
        invoice_id: e.invoiceId,
        kind: e.kind,
        amount: e.amount,
        change_date: e.changeDate,
        decision: "approved",
        reason: text,
        bulk: true,
        month_locked: e.monthLocked,
        reviewed_by: member.userId,
      })),
      { onConflict: "org_id,change_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return fail(dbMessage(error, "Could not save the approvals."));
  const n = saved?.length ?? 0;

  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.invoice_change.bulk_approved",
    entity: "fin_invoice_change_reviews",
    diff: {
      from: d.from,
      to: d.to,
      kind: d.kind,
      bulk_max: reg.bulkMax,
      picked: picked.length,
      approved: n,
      picked_amount: Math.round(picked.reduce((a, e) => a + e.amount, 0) * 100) / 100,
      reason: true,
    },
  });
  revalidatePath("/finance/invoice-changes");
  return { ok: true, message: `${n} change(s) approved.` };
}
