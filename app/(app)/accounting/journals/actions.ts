"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import {
  cleanDescription,
  cleanNarration,
  MANUAL_VOUCHER_TYPES,
  MAX_LINES,
  parseAmount,
  roundMoney,
} from "@/lib/accounting/journal";
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
import type { Json } from "@/lib/supabase/types";

/**
 * Manual journals (Phase 22A). Each step checks its own permission here; the database (acc_journal_save, acc_journal_act,
 * acc_post_journal, acc_reverse_journal: service role only) enforces the balance, the account and period rules, a
 * different person to post, the content hash the checker reviewed and the numbering. Every step is audited (ids, numbers
 * and amounts only).
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

function refresh(id?: string) {
  revalidatePath("/accounting/journals");
  revalidatePath("/accounting/dashboard");
  if (id) revalidatePath(`/accounting/journals/${id}`);
}

const optionalId = z.union([uuid, z.literal("")]).default("");
const optionalCode = (max: number) => z.string().trim().max(max).default("");

const lineSchema = z.object({
  account_id: z.union([uuid, z.literal("")]),
  debit: z.string().max(20).default(""),
  credit: z.string().max(20).default(""),
  description: z.string().max(400).default(""),
  tax_code_id: optionalId,
  branch_code: optionalCode(20),
  department: optionalCode(60),
  doctor_id: optionalCode(40),
  payer_id: optionalCode(40),
  supplier_id: optionalId,
  cost_centre_id: optionalId,
});

const journalSchema = z.object({
  id: optionalId,
  entity_id: optionalId,
  voucher_type: z.enum(MANUAL_VOUCHER_TYPES),
  journal_date: isoDate,
  narration: z.string().max(1000),
  is_adjustment: z.boolean().default(false),
  auto_reverse_on: z.union([isoDate, z.literal("")]).default(""),
  lines: z.array(lineSchema).max(MAX_LINES, "A journal has at most 500 lines."),
});

export type JournalInput = z.input<typeof journalSchema>;

export async function saveJournal(raw: JournalInput): Promise<ActionResult<{ id: string }>> {
  const member = await gate("accounting.journals.prepare");
  if (!member) return fail(DENIED);
  const p = journalSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const v = p.data;
  const narration = cleanNarration(v.narration);
  if (!narration) return fail("Say what the journal is for.");
  const lines: Json[] = [];
  for (const [i, l] of v.lines.entries()) {
    const debit = parseAmount(l.debit);
    const credit = parseAmount(l.credit);
    if (!Number.isFinite(debit) || !Number.isFinite(credit))
      return fail(`Line ${i + 1}: enter amounts as numbers.`);
    lines.push({
      account_id: l.account_id,
      debit: roundMoney(debit),
      credit: roundMoney(credit),
      description: cleanDescription(l.description),
      tax_code_id: l.tax_code_id,
      branch_code: l.branch_code,
      department: l.department,
      doctor_id: l.doctor_id,
      payer_id: l.payer_id,
      supplier_id: l.supplier_id,
      cost_centre_id: l.cost_centre_id,
    });
  }
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const { data, error } = await admin.rpc("acc_journal_save", {
    p_org_id: member.orgId,
    p_user_id: member.userId,
    p_journal_id: (v.id || null) as string,
    p_header: {
      entity_id: v.entity_id,
      voucher_type: v.voucher_type,
      journal_date: v.journal_date,
      narration,
      is_adjustment: v.is_adjustment ? "true" : "false",
      auto_reverse_on: v.auto_reverse_on,
    },
    p_lines: lines,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The journal could not be saved."));
  const r = data as { id: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: v.id ? "accounting.journal.updated" : "accounting.journal.created",
    entity: "acc_journals",
    entityId: r.id,
    diff: { voucher_type: v.voucher_type, lines: lines.length, adjustment: v.is_adjustment },
  });
  refresh(r.id);
  return { ok: true, data: { id: r.id }, message: "Draft saved." };
}

const actSchema = z.object({
  id: uuid,
  action: z.enum(["submit", "return", "discard"]),
  remarks: z.string().trim().max(500).default(""),
});

const ACT_PERM = {
  submit: "accounting.journals.prepare",
  return: "accounting.journals.approve",
  discard: "accounting.journals.prepare",
} as const;

const ACT_DONE = {
  submit: "Submitted. Someone else posts it.",
  return: "Sent back to the maker with your reason.",
  discard: "Draft deleted.",
} as const;

/** Submit a draft for posting, send one back (the checker, with a reason), or delete a draft. */
export async function journalStep(
  raw: z.input<typeof actSchema>,
): Promise<ActionResult<{ hash?: string }>> {
  const p = actSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const s = p.data;
  const member = await gate(ACT_PERM[s.action]);
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_journal_act", {
    p_org_id: member.orgId,
    p_journal_id: s.id,
    p_user_id: member.userId,
    p_action: s.action,
    p_remarks: cleanNarration(s.remarks) ?? "",
  });
  if (error || !data) return fail(rpcErrorMessage(error, "That step could not be saved."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: `accounting.journal.${s.action}`,
    entity: "acc_journals",
    entityId: s.id,
    diff: { remarks: s.remarks !== "" },
  });
  refresh(s.id);
  return {
    ok: true,
    data: { hash: (data as { hash?: string }).hash },
    message: ACT_DONE[s.action],
  };
}

const postSchema = z.object({ id: uuid, hash: z.string().regex(/^[0-9a-f]{64}$/) });

/** The checker posts a submitted journal, bound to the content hash they reviewed. */
export async function postJournal(
  raw: z.input<typeof postSchema>,
): Promise<ActionResult<{ number: string }>> {
  const p = postSchema.safeParse(raw);
  if (!p.success) return fail("Reload the page and try again.");
  const member = await gate("accounting.journals.approve");
  if (!member) return fail(DENIED);
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_post_journal", {
    p_org_id: member.orgId,
    p_journal_id: p.data.id,
    p_user_id: member.userId,
    p_hash: p.data.hash,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The journal could not be posted."));
  const r = data as { id: string; number: string; total: number; sha256: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.journal.posted",
    entity: "acc_journals",
    entityId: r.id,
    diff: { number: r.number, total: r.total, sha256: r.sha256 },
  });
  refresh(r.id);
  return { ok: true, data: { number: r.number }, message: `Posted as ${r.number}.` };
}

const reverseSchema = z.object({
  id: uuid,
  date: isoDate,
  reason: z.string().trim().min(3, "Say why the journal is reversed.").max(200),
});

/** Reverse a posted journal: the mirror journal is posted on the date given and both are linked. */
export async function reverseJournal(
  raw: z.input<typeof reverseSchema>,
): Promise<ActionResult<{ id: string; number: string }>> {
  const p = reverseSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const member = await gate("accounting.journals.approve");
  if (!member) return fail(DENIED);
  const reason = cleanNarration(p.data.reason);
  if (!reason) return fail("Say why the journal is reversed.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_reverse_journal", {
    p_org_id: member.orgId,
    p_journal_id: p.data.id,
    p_user_id: member.userId,
    p_date: p.data.date,
    p_reason: reason,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The journal could not be reversed."));
  const r = data as { id: string; number: string; reversal_of: string };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.journal.reversed",
    entity: "acc_journals",
    entityId: p.data.id,
    diff: { reversal_id: r.id, reversal_number: r.number, date: p.data.date },
  });
  refresh(p.data.id);
  refresh(r.id);
  return { ok: true, data: { id: r.id, number: r.number }, message: `Reversed by ${r.number}.` };
}
