"use server";

import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { rpcErrorMessage } from "@/lib/accounting/errors";
import { parseTrialBalanceTable } from "@/lib/accounting/tally/tb-file";
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
import { MAX_IMPORT_BYTES, readImportFile } from "@/lib/finance/parse-import";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reconciliation of a Tally import (Phase 22I), accounting.import: Pulse's trial balance against Tally's, exported to
 * Excel or CSV. The file is read once and never stored (sha256 only). Locking the imported months also needs
 * accounting.periods.manage and the typed word LOCK. Audited with ids and counts only.
 */

async function gate(permission: string) {
  const member = await requireMember();
  return can(member, permission) ? member : null;
}

const TB_ERRORS: Record<string, string> = {
  no_header: "No header row with Debit and Credit columns was found.",
  bad_amount: "An amount cannot be read",
  duplicate_name: "A ledger appears twice",
  empty: "The file holds no balances.",
};

const reconcileSchema = z.object({
  as_at: isoDate,
  import_id: z.union([uuid, z.literal("")]).default(""),
  // Which entity's books to compare when no import is chosen (an import carries its own entity). Empty: the default one.
  entity_id: z.union([uuid, z.literal("")]).default(""),
});

export type ReconcileOutcome = {
  id: string;
  compared: number;
  differences: number;
  reconciled: boolean;
  total_difference: number;
  group_rows_ignored: number;
};

export async function reconcileWithTally(fd: FormData): Promise<ActionResult<ReconcileOutcome>> {
  const member = await gate("accounting.import");
  if (!member) return fail(DENIED);
  const p = reconcileSchema.safeParse({
    as_at: fd.get("as_at"),
    import_id: fd.get("import_id") ?? "",
    entity_id: fd.get("entity_id") ?? "",
  });
  if (!p.success) return fail(firstIssue(p.error));
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return fail("Choose Tally's trial balance file.");
  if (file.size > MAX_IMPORT_BYTES) return fail("The file is larger than 5 MB.");
  if (!/\.(csv|xlsx)$/i.test(file.name)) return fail("Upload the trial balance as .xlsx or .csv.");
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const sha = createHash("sha256").update(buffer).digest("hex");
    const tb = parseTrialBalanceTable(await readImportFile(buffer));
    if (!tb.ok) return fail(`${TB_ERRORS[tb.error]}${tb.detail ? ` (${tb.detail})` : ""}.`);
    const { data, error } = await admin.rpc("acc_tally_reconcile", {
      p_org_id: member.orgId,
      p_entity_id: (p.data.import_id ? null : p.data.entity_id || null) as unknown as string,
      p_import_id: (p.data.import_id || null) as unknown as string,
      p_user_id: member.userId,
      p_as_at: p.data.as_at,
      p_file_sha256: sha,
      p_rows: tb.rows,
    });
    if (error || !data) return fail(rpcErrorMessage(error, "The reconciliation could not be run."));
    const r = data as unknown as ReconcileOutcome;
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "accounting.tally_import.reconciled",
      entity: "acc_tally_reconciliations",
      entityId: r.id,
      diff: {
        import_id: p.data.import_id || null,
        entity_id: p.data.import_id ? null : p.data.entity_id || null,
        as_at: p.data.as_at,
        compared: r.compared,
        differences: r.differences,
      },
    });
    revalidatePath("/accounting/tally-reconciliation");
    revalidatePath("/accounting/tally-import");
    return {
      ok: true,
      data: r,
      message: r.reconciled
        ? "Reconciled: every ledger agrees with Tally."
        : `${r.differences} ledger(s) differ.`,
    };
  } catch (err) {
    console.error("[accounting] tally reconciliation failed", { error: redactText(err, 100) });
    return fail(
      "The file could not be read. Export the trial balance from Tally to Excel and try again.",
    );
  }
}

const lockSchema = z.object({ id: uuid, confirm: z.string().trim().default("") });

/** Closes and locks every month the import covers (it must be reconciled first). Final, like any lock. */
export async function lockImportedPeriods(values: Record<string, string>): Promise<ActionResult> {
  const member = await gate("accounting.import");
  if (!member || !can(member, "accounting.periods.manage")) return fail(DENIED);
  const p = lockSchema.safeParse(values);
  if (!p.success) return fail("Reload the page and try again.");
  if (p.data.confirm !== "LOCK")
    return fail("Type LOCK to lock the imported months. They can never be opened again.");
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin.rpc("acc_tally_lock_periods", {
    p_org_id: member.orgId,
    p_import_id: p.data.id,
    p_user_id: member.userId,
  });
  if (error || !data) return fail(rpcErrorMessage(error, "The months could not be locked."));
  const r = data as { locked: number };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "accounting.tally_import.periods_locked",
    entity: "acc_tally_imports",
    entityId: p.data.id,
    diff: { locked: r.locked },
  });
  revalidatePath("/accounting/tally-reconciliation");
  revalidatePath("/accounting/periods");
  return { ok: true, message: `${r.locked} month(s) locked.` };
}
