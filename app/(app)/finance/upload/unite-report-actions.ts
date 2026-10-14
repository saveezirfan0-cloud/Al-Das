"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { MAX_REPORT_BYTES } from "@/lib/finance/unite-report-mapping";
import {
  commitUniteReport,
  discardUniteReport,
  loadUniteReportSummary,
  safeReportMessage,
  stageUniteReport,
  UniteReportDbError,
  type CommitResult,
  type UploadSummary,
} from "@/lib/finance/unite-report-service";
import { UniteReportError } from "@/lib/finance/parse-unite-report";
import { redactText } from "@/lib/redact";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Phase 23A: the Unite "Daily Collection Multi-Clinic Report" upload. The browser uploads the .xlsx to a signed URL in the
 * private finance-files bucket; the server reads it, deletes it at once (it holds patient names), keeps only the
 * sanitised rows and the file's sha256, and shows a preview. Commit and discard are separate steps.
 */

const FINANCE_BUCKET = "finance-files";
const PERM = "finance.revenue.import";

export type ActionResult<T = undefined> =
  { ok: true; message?: string; data: T } | { ok: false; error: string };

const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  size: z.number().int().positive().max(MAX_REPORT_BYTES, "The file is larger than 25 MB."),
});
const idSchema = z.string().uuid();

function logFailure(step: string, err: unknown) {
  if (err instanceof UniteReportError || err instanceof UniteReportDbError) return;
  console.error(`[finance] unite report ${step} failed`, { error: redactText(err) });
}

/** Signed upload URL so the browser uploads straight to Storage (no Vercel body limit). */
export async function createUniteReportUpload(
  input: z.input<typeof uploadSchema>,
): Promise<ActionResult<{ path: string; token: string }>> {
  const member = await requirePerm(PERM);
  const parsed = uploadSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid file." };
  if (!/\.xlsx$/i.test(parsed.data.filename))
    return { ok: false, error: "Upload the .xlsx file exported from Unite." };
  const path = `${member.orgId}/unite-report/${randomUUID()}.xlsx`;
  const { data, error } = await createAdminClient()
    .storage.from(FINANCE_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) return { ok: false, error: "Could not prepare the upload. Try again." };
  return { ok: true, data: { path: data.path, token: data.token } };
}

const processSchema = z.object({ path: z.string().min(1).max(300) });

/** Read, check and stage the uploaded report. The original file is deleted in every case. */
export async function processUniteReportUpload(
  input: z.input<typeof processSchema>,
): Promise<ActionResult<UploadSummary>> {
  const member = await requirePerm(PERM);
  const parsed = processSchema.safeParse(input);
  const prefix = `${member.orgId}/unite-report/`;
  if (
    !parsed.success ||
    !parsed.data.path.startsWith(prefix) ||
    !/^[0-9a-f-]{36}\.xlsx$/.test(parsed.data.path.slice(prefix.length))
  )
    return { ok: false, error: "Invalid upload path." };
  const path = parsed.data.path;
  const admin = createAdminClient();
  try {
    const { data: blob, error } = await admin.storage.from(FINANCE_BUCKET).download(path);
    if (error || !blob)
      return { ok: false, error: "The uploaded file could not be read. Try again." };
    const buffer = Buffer.from(await blob.arrayBuffer());
    // delete the original before anything else: it holds patient names
    await admin.storage.from(FINANCE_BUCKET).remove([path]);
    if (buffer.length > MAX_REPORT_BYTES)
      return { ok: false, error: "The file is larger than 25 MB." };

    const summary = await stageUniteReport(admin, {
      orgId: member.orgId,
      userId: member.userId,
      buffer,
    });
    if (!summary.existing)
      await recordAudit(admin, {
        orgId: member.orgId,
        userId: member.userId,
        action: "finance.unite_report.staged",
        entity: "fin_report_uploads",
        entityId: summary.uploadId,
        diff: {
          from_date: summary.fromDate,
          to_date: summary.toDate,
          rows: summary.rowCount,
          reconciled: summary.reconciled,
          problems: summary.problems.length,
        },
      });
    revalidatePath("/finance/upload");
    return { ok: true, data: summary };
  } catch (err) {
    logFailure("upload", err);
    return { ok: false, error: safeReportMessage(err) };
  } finally {
    await admin.storage.from(FINANCE_BUCKET).remove([path]);
  }
}

/** The preview of an upload (to review a staged one again from the list). */
export async function getUniteReportUpload(uploadId: string): Promise<ActionResult<UploadSummary>> {
  const member = await requirePerm(PERM);
  if (!idSchema.safeParse(uploadId).success) return { ok: false, error: "Invalid upload." };
  try {
    return {
      ok: true,
      data: await loadUniteReportSummary(createAdminClient(), member.orgId, uploadId),
    };
  } catch (err) {
    logFailure("preview", err);
    return { ok: false, error: safeReportMessage(err) };
  }
}

/** Makes a staged, reconciled upload the current data for its date range. */
export async function commitUniteReportUpload(
  uploadId: string,
): Promise<ActionResult<CommitResult>> {
  const member = await requirePerm(PERM);
  if (!idSchema.safeParse(uploadId).success) return { ok: false, error: "Invalid upload." };
  const admin = createAdminClient();
  try {
    const res = await commitUniteReport(admin, {
      orgId: member.orgId,
      userId: member.userId,
      uploadId,
    });
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.unite_report.committed",
      entity: "fin_report_uploads",
      entityId: uploadId,
      diff: {
        rows: res.rows,
        superseded: res.superseded,
        unknown_branch_rows: res.unknownBranchRows,
      },
    });
    revalidatePath("/finance/upload");
    return { ok: true, message: "Report committed.", data: res };
  } catch (err) {
    logFailure("commit", err);
    return { ok: false, error: safeReportMessage(err) };
  }
}

/** Deletes a staged upload and its rows. A committed upload is never deleted. */
export async function discardUniteReportUpload(uploadId: string): Promise<ActionResult> {
  const member = await requirePerm(PERM);
  if (!idSchema.safeParse(uploadId).success) return { ok: false, error: "Invalid upload." };
  const admin = createAdminClient();
  try {
    const res = await discardUniteReport(admin, member.orgId, uploadId);
    await recordAudit(admin, {
      orgId: member.orgId,
      userId: member.userId,
      action: "finance.unite_report.discarded",
      entity: "fin_report_uploads",
      entityId: uploadId,
      diff: { rows: res.rows },
    });
    revalidatePath("/finance/upload");
    return { ok: true, message: "Upload discarded.", data: undefined };
  } catch (err) {
    logFailure("discard", err);
    return { ok: false, error: safeReportMessage(err) };
  }
}
