"use server";

import { revalidatePath } from "next/cache";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, uuid, type ActionResult } from "@/lib/finance/action-support";
import { previewImportTable } from "@/lib/finance/import-preview";
import type { AmountStyle, DateFormat } from "@/lib/finance/import-kinds";
import { MAX_IMPORT_BYTES, readImportFile } from "@/lib/finance/parse-import";
import { importReceiptRegister } from "@/lib/finance/receipts-server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { UploadPreview } from "@/lib/upload/preview";

/**
 * Insurer receipt register import (matching v2). Needs finance.matching.manage. The file is read from memory, only the
 * layout's mapped columns are used, the original is never kept (sha256 only) and the audit row holds counts only.
 */

const PERM = "finance.matching.manage";

async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

export type ReceiptImportOutcome = {
  inserted: number;
  alreadyStored: number;
  rows: number;
  skipped: number;
};

function readForm(fd: FormData): { file: File; formatId: string } | { error: string } {
  const file = fd.get("file");
  const formatId = uuid.safeParse(fd.get("format_id"));
  if (!formatId.success) return { error: "Choose the layout first." };
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
  if (file.size > MAX_IMPORT_BYTES) return { error: "The file is larger than 5 MB. Split it." };
  if (!/\.(csv|xlsx)$/i.test(file.name)) return { error: "Upload a .csv or .xlsx file." };
  return { file, formatId: formatId.data };
}

/** Shows the mapped columns of the first rows (redacted), the other columns by name only. Nothing is stored. */
export async function previewReceiptRegisterAction(
  fd: FormData,
): Promise<ActionResult<UploadPreview>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const form = readForm(fd);
  if ("error" in form) return fail(form.error);
  const admin = createAdminClient(); // service role AFTER the permission check: the layout only
  const { data: format } = await admin
    .from("fin_import_formats")
    .select("kind, mapping, date_format, amount_style, active")
    .eq("org_id", member.orgId)
    .eq("id", form.formatId)
    .maybeSingle();
  if (!format || !format.active || format.kind !== "receipt_register")
    return fail("Choose an active layout for the receipt register.");
  let table: unknown[][];
  try {
    table = await readImportFile(Buffer.from(await form.file.arrayBuffer()));
  } catch {
    return fail("The file could not be read. Save it as .csv or .xlsx and try again.");
  }
  return {
    ok: true,
    data: previewImportTable(table, {
      kind: "receipt_register",
      mapping: (format.mapping ?? {}) as Record<string, string>,
      dateFormat: format.date_format as DateFormat,
      amountStyle: format.amount_style as AmountStyle,
    }),
  };
}

export async function importReceiptRegisterAction(
  fd: FormData,
): Promise<ActionResult<ReceiptImportOutcome>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const form = readForm(fd);
  if ("error" in form) return fail(form.error);
  const admin = createAdminClient(member.userId); // service role AFTER the permission check
  const res = await importReceiptRegister(admin, {
    orgId: member.orgId,
    userId: member.userId,
    formatId: form.formatId,
    fileName: form.file.name,
    buffer: Buffer.from(await form.file.arrayBuffer()),
  });
  if (!res.ok) return fail(res.error);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.receipts.imported",
    entity: "fin_bank_imports",
    entityId: res.importId,
    diff: {
      rows: res.rows,
      inserted: res.inserted,
      already_stored: res.alreadyStored,
      skipped: res.skipped,
    },
  });
  revalidatePath("/finance/matching");
  return {
    ok: true,
    message:
      `Imported ${res.inserted} payment(s)` +
      (res.alreadyStored ? `, ${res.alreadyStored} already stored with the same figures` : "") +
      (res.skipped ? `, ${res.skipped} blank, zero or repeated line(s) skipped` : "") +
      ".",
    data: {
      inserted: res.inserted,
      alreadyStored: res.alreadyStored,
      rows: res.rows,
      skipped: res.skipped,
    },
  };
}
