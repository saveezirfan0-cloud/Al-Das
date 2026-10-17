"use server";

import { randomUUID } from "node:crypto";
import { formatInTimeZone } from "date-fns-tz";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { UniteExportError, MAX_EXPORT_BYTES } from "@/lib/finance/unite-export";
import { storeAndProcessUniteExport, type ExportResult } from "@/lib/finance/unite-export-server";
import { dbUniteExportDeps } from "@/lib/finance/unite-export-db";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * The saved Unite pull (a JSON file). The browser uploads it to a signed URL in the private finance-files bucket;
 * the server reads it, ALWAYS deletes the Storage object, stores it as raw batches first and then processes them.
 * Nothing here calls Unite (CLAUDE.md rule 7).
 */

const FINANCE_BUCKET = "finance-files";
const PERM = "finance.revenue.import";
const CONFIRM_WORD = "UPLOAD";

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_EXPORT_BYTES, "The file is larger than 25 MB."),
});

/** Signed upload URL so the browser uploads straight to Storage (no Vercel body limit). */
export async function createUniteExportUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const member = await requirePerm(PERM);
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid file." };
  if (!/\.json$/i.test(parsed.data.filename))
    return { ok: false, error: "Upload the saved Unite export (.json file)." };
  const path = `${member.orgId}/unite-export/${randomUUID()}.json`;
  const { data, error } = await createAdminClient()
    .storage.from(FINANCE_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Could not prepare the upload. Try again." };
  return { ok: true, data: { path: data.path, token: data.token } };
}

const processSchema = z.object({
  path: z.string().min(1).max(300),
  filename: z.string().trim().max(200).optional(),
  pulledOn: z.string().min(1).max(10),
  confirm: z.string().max(40),
});

/** Store the uploaded export as raw batches, then process them. The Storage object is deleted in every case. */
export async function processUniteExportUpload(
  input: z.input<typeof processSchema>,
): Promise<ActionResult<ExportResult>> {
  const member = await requirePerm(PERM);
  const parsed = processSchema.safeParse(input);
  const prefix = `${member.orgId}/unite-export/`;
  if (
    !parsed.success ||
    !parsed.data.path.startsWith(prefix) ||
    !/^[0-9a-f-]{36}\.json$/.test(parsed.data.path.slice(prefix.length))
  )
    return { ok: false, error: "Invalid upload path." };
  const path = parsed.data.path;
  const admin = createAdminClient();
  try {
    if (parsed.data.confirm.trim().toUpperCase() !== CONFIRM_WORD)
      return { ok: false, error: `Type ${CONFIRM_WORD} to confirm.` };
    const { data: blob, error } = await admin.storage.from(FINANCE_BUCKET).download(path);
    if (error || !blob)
      return { ok: false, error: "The uploaded file could not be read. Try again." };
    const text = Buffer.from(await blob.arrayBuffer()).toString("utf8");
    await admin.storage.from(FINANCE_BUCKET).remove([path]); // the file is not kept

    const { data: org } = await admin.from("orgs").select("timezone").eq("id", member.orgId).maybeSingle();
    const result = await storeAndProcessUniteExport(dbUniteExportDeps(admin, member.orgId), {
      text,
      pulledOn: parsed.data.pulledOn,
      today: formatInTimeZone(new Date(), org?.timezone ?? "Asia/Dubai", "yyyy-MM-dd"),
      fileName: parsed.data.filename ?? null,
      userId: member.userId,
    });
    if (result.failed) result.failed.error = redactText(result.failed.error);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.unite_export.uploaded",
      entity: "fin_raw_unite_batches",
      diff: {
        pulled_on: parsed.data.pulledOn,
        records: result.records,
        chunks: result.chunks,
        stored: result.storedNow,
        already_stored: result.alreadyStored,
        processed: result.processedNow,
        failed_chunk: result.failed?.chunk ?? null,
      },
    });
    revalidatePath("/finance/upload");
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof UniteExportError) return { ok: false, error: err.message };
    console.error("[finance] unite export upload failed", { error: redactText(err) });
    return { ok: false, error: "The file could not be processed. Nothing was sent to Unite." };
  } finally {
    await admin.storage.from(FINANCE_BUCKET).remove([path]);
  }
}
