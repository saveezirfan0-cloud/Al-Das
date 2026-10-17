import "server-only";

import { createHash } from "node:crypto";

import type { DateFormat, AmountStyle } from "@/lib/finance/import-kinds";
import { MAX_IMPORT_BYTES, parseReceiptRegister, readImportFile } from "@/lib/finance/parse-import";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Stores an insurer receipt register. Callers have run can('finance.matching.manage'). The file is read from memory,
 * parsed with the layout's mapped columns only and handed to the database function in one atomic call; only its sha256
 * is kept (never the file, never its name beyond the extension). Errors carry row numbers and field names, never values.
 */

export type ReceiptImportInput = {
  orgId: string;
  userId: string;
  formatId: string;
  fileName: string;
  buffer: Buffer;
};
export type ReceiptImportResult =
  | { ok: true; importId: string | null; inserted: number; alreadyStored: number; rows: number; skipped: number }
  | { ok: false; error: string; missing?: string[]; errors?: string[] };

/** The function is newer than the generated types; the cast goes away when `pnpm db:migrate` regenerates them. */
type LooseRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>;
const rpc = (admin: AdminClient) => admin.rpc.bind(admin) as unknown as LooseRpc;

const GENERIC = "Nothing was imported. Check the file and try again.";

export async function importReceiptRegister(
  admin: AdminClient,
  input: ReceiptImportInput,
): Promise<ReceiptImportResult> {
  if (input.buffer.length === 0) return { ok: false, error: "Choose a file." };
  if (input.buffer.length > MAX_IMPORT_BYTES)
    return { ok: false, error: "The file is larger than 5 MB. Split it." };
  const { data: format } = await admin
    .from("fin_import_formats")
    .select("id, kind, mapping, date_format, amount_style, active")
    .eq("org_id", input.orgId)
    .eq("id", input.formatId)
    .maybeSingle();
  if (!format || !format.active || format.kind !== "receipt_register")
    return { ok: false, error: "Choose an active layout for the receipt register." };

  const sha = createHash("sha256").update(input.buffer).digest("hex");
  let table: unknown[][];
  try {
    table = await readImportFile(input.buffer);
  } catch {
    return { ok: false, error: "The file could not be read. Save it as .csv or .xlsx and try again." };
  }
  const parsed = parseReceiptRegister(table, {
    kind: "receipt_register",
    mapping: (format.mapping ?? {}) as Record<string, string>,
    dateFormat: format.date_format as DateFormat,
    amountStyle: format.amount_style as AmountStyle,
  });
  if (!parsed.ok) {
    const head = parsed.missing.length ? `Missing columns: ${parsed.missing.join("; ")}. ` : "";
    return {
      ok: false,
      error: `Nothing was imported. ${head}${parsed.errors.join(" ")}`.trim(),
      missing: parsed.missing,
      errors: parsed.errors,
    };
  }

  const { data, error } = await rpc(admin)("fin_receipts_import", {
    p_org_id: input.orgId,
    p_format_id: format.id,
    // the extension only: a file name can carry a person's name
    p_file_name: /\.(csv|xlsx)$/i.exec(input.fileName)?.[0].toLowerCase() ?? "",
    p_sha256: sha,
    p_rows: parsed.rows as unknown as Json,
    p_user: input.userId,
  });
  if (error) {
    if (error.code === "23505")
      return { ok: false, error: "This file was already imported. Nothing was changed." };
    if (error.code === "23514" && /already stored with a different amount/.test(error.message))
      return { ok: false, error: `Nothing was imported: ${error.message}.` };
    console.error("[finance] receipt import failed", {
      code: error.code,
      detail: redactText(error.message, 80),
    });
    return { ok: false, error: GENERIC };
  }
  const out = (data ?? {}) as { import_id?: string; inserted?: number; already_stored?: number };
  return {
    ok: true,
    importId: out.import_id ?? null,
    inserted: Number(out.inserted ?? 0),
    alreadyStored: Number(out.already_stored ?? 0),
    rows: parsed.stats.rows,
    skipped: parsed.stats.skipped,
  };
}
