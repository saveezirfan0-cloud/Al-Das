"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { roundMoney } from "@/lib/accounting/journal";
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
 * Opening balances typed in (Phase 22I), the manual alternative to the Tally import: one 'opening' journal at the
 * opening date, prepared and submitted here (accounting.import; the database also needs accounting.journals.prepare)
 * and posted by a different person with accounting.journals.approve on the journal's own page (maker and checker, as
 * for every manual journal). Audited with ids and counts.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const amount = z.number().finite().min(0).max(1e11);
const schema = z.object({
  date: isoDate,
  lines: z
    .array(z.object({ account_id: uuid, debit: amount, credit: amount }))
    .min(2, "Enter at least two balances.")
    .max(500, "A journal has at most 500 lines."),
});

export async function prepareOpeningBalances(
  input: z.input<typeof schema>,
): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.import");
  if (!member) return fail(DENIED);
  const p = schema.safeParse(input);
  if (!p.success) return fail(firstIssue(p.error));
  const lines = p.data.lines
    .map((l) => ({
      account_id: l.account_id,
      debit: roundMoney(l.debit),
      credit: roundMoney(l.credit),
    }))
    .filter((l) => l.debit > 0 || l.credit > 0);
  if (lines.some((l) => l.debit > 0 && l.credit > 0))
    return fail("Enter a debit or a credit on each account, not both.");
  const dr = lines.reduce((a, l) => a + Math.round(l.debit * 100), 0);
  const cr = lines.reduce((a, l) => a + Math.round(l.credit * 100), 0);
  if (dr !== cr) return fail("Debits and credits must be equal.");
  if (lines.length < 2) return fail("Enter at least two balances.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_journal_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_journal_id: null as unknown as string,
    p_header: { voucher_type: "opening", journal_date: p.data.date, narration: "Opening balances" },
    p_lines: lines,
  });
  if (error || !data)
    return fail(rpcErrorMessage(error, "The opening balances could not be saved."));
  const id = (data as { id: string }).id;
  const { error: subErr } = await admin.rpc("acc_journal_act", {
    p_org_id: member.orgId,
    p_journal_id: id,
    p_user_id: member.userId,
    p_action: "submit",
    p_remarks: "",
  });
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.opening_balances.prepared",
    entity: "acc_journals",
    entityId: id,
    diff: { lines: lines.length, submitted: !subErr, date: p.data.date },
  });
  revalidatePath("/accounting/journals");
  if (subErr)
    return {
      ok: true,
      data: { id },
      message: `Saved as a draft; it could not be submitted yet: ${rpcErrorMessage(subErr, "check it")}`,
    };
  return {
    ok: true,
    data: { id },
    message: "Submitted. Someone else with the post permission posts it.",
  };
}
