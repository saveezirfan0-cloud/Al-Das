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
import { buildAccountingExport, validPeriod } from "@/lib/finance/export-server";
import { createAdminClient } from "@/lib/supabase/admin";

/** Accounting export. Every action needs finance.export.run. The account map is edited here (a mapping, not patient data). */

const PERM = "finance.export.run";
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

const periodSchema = z.object({ from: isoDate, to: isoDate });

export type ExportPreview = {
  status: "provisional" | "final";
  openMonths: string[];
  needed: Array<{ kind: string; key: string; mapped: boolean }>;
  ready: boolean;
  rows: number;
  debit: number;
  credit: number;
};

/** Checks the period: which accounts are needed, which are missing, and how big the file would be. Writes nothing. */
export async function previewAccountingExport(raw: {
  from: string;
  to: string;
}): Promise<ActionResult<ExportPreview>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = periodSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const bad = validPeriod(p.data.from, p.data.to);
  if (bad) return fail(bad);
  const admin = createAdminClient(member.userId);
  try {
    const b = await buildAccountingExport(admin, member.orgId, p.data.from, p.data.to);
    return {
      ok: true,
      data: {
        status: b.status,
        openMonths: b.openMonths,
        needed: b.needed,
        ready: b.result.ok,
        rows: b.result.ok ? b.result.rowCount : 0,
        debit: b.result.ok ? b.result.debitTotal : 0,
        credit: b.result.ok ? b.result.creditTotal : 0,
      },
    };
  } catch {
    return fail("Could not read the figures for that period.");
  }
}

const mapSchema = z.object({
  kind: z.enum([
    "revenue",
    "payment_mode",
    "receivable",
    "vat_output",
    "writeoff",
    "credit_note",
    "rounding",
    "refund",
  ]),
  key: z.string().trim().min(1).max(80),
  account_code: z.string().trim().min(1, "Enter the account code.").max(40),
  account_name: z.string().trim().max(120).default(""),
});

export async function saveAccountMapping(raw: Record<string, string>): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = mapSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const singleton = !["revenue", "payment_mode", "receivable"].includes(p.data.kind);
  const admin = createAdminClient(member.userId);
  const { error } = await admin.from("fin_ref_account_map").upsert(
    {
      org_id: member.orgId,
      kind: p.data.kind,
      key: singleton ? "*" : p.data.key,
      account_code: p.data.account_code,
      account_name: p.data.account_name || null,
    },
    { onConflict: "org_id,kind,key" },
  );
  if (error) return fail(dbMessage(error, "Could not save the account."));
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.export.account_saved",
    entity: "fin_ref_account_map",
    entityId: `${p.data.kind}:${singleton ? "*" : p.data.key}`,
  });
  revalidatePath("/finance/export");
  return { ok: true, message: "Account saved." };
}

export async function deleteAccountMapping(raw: {
  kind: string;
  key: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = mapSchema.pick({ kind: true, key: true }).safeParse(raw);
  if (!p.success) return fail("Invalid account.");
  const admin = createAdminClient(member.userId);
  const { error } = await admin
    .from("fin_ref_account_map")
    .delete()
    .eq("org_id", member.orgId)
    .eq("kind", p.data.kind)
    .eq("key", p.data.key);
  if (error) return fail("Could not remove the account.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.export.account_removed",
    entity: "fin_ref_account_map",
    entityId: `${p.data.kind}:${p.data.key}`,
  });
  revalidatePath("/finance/export");
  return { ok: true, message: "Removed." };
}
