"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { DENIED, fail, firstIssue, uuid, type ActionResult } from "@/lib/finance/action-support";
import type { ValidationError } from "@/lib/finance/parse-diligence";
import type { RemitHeaderReport } from "@/lib/finance/parse-remittance";
import {
  buildRemittancePreview,
  commitRemittance,
  discardRemittance,
  stageRemittance,
  type RemitPreview,
} from "@/lib/finance/remittance-service";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Remittance reconciliation. Every action needs finance.remittance.manage. The uploaded advice can hold patient names and
 * member IDs: it goes to a private bucket by signed URL, is read once on the server, is ALWAYS deleted afterwards, and only
 * sanitised lines are kept. Matching never changes a claim (Diligence stays the source of truth).
 */

const PERM = "finance.remittance.manage";
const BUCKET = "finance-files";
const MAX_BYTES = 25 * 1024 * 1024;
async function gate() {
  const member = await requireMember();
  return can(member, PERM) ? member : null;
}

export type RemitOutcome =
  | { kind: "duplicate"; fileId: string; committedAt: string | null }
  | {
      kind: "rejected";
      fileId: string;
      errors: ValidationError[];
      totalErrors: number;
      header: RemitHeaderReport;
    }
  | { kind: "staged"; fileId: string; preview: RemitPreview };

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_BYTES, "The file is larger than 25 MB."),
});

/** A signed upload URL so the browser sends the file straight to private storage. */
export async function createRemittanceUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success) return fail(firstIssue(parsed.error, "Invalid file."));
  const ext = /\.xlsx$/i.test(parsed.data.filename)
    ? "xlsx"
    : /\.csv$/i.test(parsed.data.filename)
      ? "csv"
      : null;
  if (!ext) return fail("Upload the payment advice as an .xlsx or .csv file.");
  const path = `${member.orgId}/remittance/${randomUUID()}.${ext}`;
  const { data, error } = await createAdminClient()
    .storage.from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) return fail("Could not prepare the upload.");
  return { ok: true, data: { path: data.path, token: data.token } };
}

/** Reads the uploaded file, stages the sanitised lines, and ALWAYS deletes the original. */
export async function processRemittanceUpload(input: {
  path: string;
  filename: string;
}): Promise<ActionResult<RemitOutcome>> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (
    typeof input.path !== "string" ||
    !input.path.startsWith(`${member.orgId}/remittance/`) ||
    input.path.includes("..")
  )
    return fail("Invalid upload path.");
  const admin = createAdminClient(member.userId);
  try {
    const { data: blob, error } = await admin.storage.from(BUCKET).download(input.path);
    if (error || !blob) return fail("The uploaded file could not be read. Try again.");
    const buffer = Buffer.from(await blob.arrayBuffer());
    if (buffer.length > MAX_BYTES) return fail("The file is larger than 25 MB.");
    const out = await stageRemittance(admin, {
      orgId: member.orgId,
      userId: member.userId,
      fileName: String(input.filename ?? "").slice(0, 200),
      buffer,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.remittance.uploaded",
      entity: "fin_raw_remittance_files",
      entityId: out.fileId,
      diff: { outcome: out.status },
    });
    revalidatePath("/finance/remittance");
    if (out.status === "duplicate")
      return {
        ok: true,
        data: { kind: "duplicate", fileId: out.fileId, committedAt: out.committedAt },
      };
    if (out.status === "rejected")
      return {
        ok: true,
        data: {
          kind: "rejected",
          fileId: out.fileId,
          errors: out.errors,
          totalErrors: out.totalErrors,
          header: out.header,
        },
      };
    const preview = await buildRemittancePreview(admin, member.orgId, out.fileId);
    if (!preview) return fail("Could not build the preview.");
    return { ok: true, data: { kind: "staged", fileId: out.fileId, preview } };
  } catch (err) {
    console.error("[finance] remittance upload failed", { error: redactText(err, 100) });
    return fail("The file could not be processed. Check that it is the payer's payment advice.");
  } finally {
    await admin.storage.from(BUCKET).remove([input.path]);
  }
}

export async function commitRemittanceFile(fileId: string): Promise<
  ActionResult<{
    batchId: string;
    lines: number;
    duplicatesSkipped: number;
    short: number;
    unmatched: number;
  }>
> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(fileId).success) return fail("Invalid file.");
  const admin = createAdminClient(member.userId);
  try {
    const res = await commitRemittance(admin, {
      orgId: member.orgId,
      userId: member.userId,
      fileId,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.remittance.committed",
      entity: "fin_raw_remittance_files",
      entityId: fileId,
      diff: {
        lines: res.lines,
        duplicates_skipped: res.duplicatesSkipped,
        short: res.summary.short,
        unmatched: res.summary.unmatched + res.summary.ambiguous,
      },
    });
    revalidatePath("/finance/remittance");
    return {
      ok: true,
      message: "Payment advice reconciled.",
      data: {
        batchId: res.batchId,
        lines: res.lines,
        duplicatesSkipped: res.duplicatesSkipped,
        short: res.summary.short,
        unmatched: res.summary.unmatched + res.summary.ambiguous,
      },
    };
  } catch (err) {
    return fail(
      err instanceof Error && /already committed|preview expired|not found/.test(err.message)
        ? err.message
        : "Could not save the reconciliation.",
    );
  }
}

export async function discardRemittanceFile(fileId: string): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  if (!uuid.safeParse(fileId).success) return fail("Invalid file.");
  const admin = createAdminClient(member.userId);
  await discardRemittance(admin, member.orgId, fileId);
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.remittance.discarded",
    entity: "fin_raw_remittance_files",
    entityId: fileId,
  });
  revalidatePath("/finance/remittance");
  return { ok: true, message: "Upload discarded." };
}

const reviewSchema = z.object({ id: uuid, note: z.string().trim().max(500).default("") });

/** Marks a flagged line as looked at. The note is optional and never contains patient detail by design (ids only). */
export async function reviewRemittanceLine(raw: {
  id: string;
  note?: string;
}): Promise<ActionResult> {
  const member = await gate();
  if (!member) return fail(DENIED);
  const p = reviewSchema.safeParse(raw);
  if (!p.success) return fail(firstIssue(p.error));
  const admin = createAdminClient(member.userId);
  const { data, error } = await admin
    .from("ins_remittance_lines")
    .update({
      reviewed_by: member.userId,
      reviewed_at: new Date().toISOString(),
      review_note: p.data.note || null,
    })
    .eq("id", p.data.id)
    .eq("org_id", member.orgId)
    .select("batch_id");
  if (error || !data?.length) return fail("Could not mark that line as reviewed.");
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.remittance.line_reviewed",
    entity: "ins_remittance_lines",
    entityId: p.data.id,
  });
  revalidatePath(`/finance/remittance/${data[0].batch_id}`);
  return { ok: true, message: "Marked as reviewed." };
}
