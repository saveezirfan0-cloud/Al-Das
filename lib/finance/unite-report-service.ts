import "server-only";

import { createHash } from "node:crypto";

import { parseUniteReport, UniteReportError } from "@/lib/finance/parse-unite-report";
import { RECONCILED_TOTAL_KEYS, type ReconciledTotal } from "@/lib/finance/unite-report-mapping";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Phase 23A: the Unite collection report through the database functions (service role; the caller has already checked
 * can('finance.revenue.import')). Everything returned is counts, dates and totals, never a row.
 */

export type UploadSummary = {
  uploadId: string;
  existing: boolean;
  status: "staged" | "committed" | "discarded";
  fromDate: string;
  toDate: string;
  rowCount: number;
  reconciled: boolean;
  reportTotals: Record<ReconciledTotal, number>;
  rowTotals: Record<ReconciledTotal, number>;
  problems: string[];
  doctors: number;
  clinics: number;
  cancelledRows: number;
  unknownBranchRows: number;
};

export type CommitResult = { rows: number; superseded: number; unknownBranchRows: number };

/** Fixed sentences for the database's error keywords; anything else is a generic failure. */
const DB_ERRORS: Record<string, string> = {
  report_not_found: "That upload was not found.",
  report_not_staged:
    "That upload is no longer waiting for review (already committed or discarded).",
  report_not_reconciled:
    "The rows do not add up to the report's totals, so this upload cannot be committed.",
  report_rows_out_of_range: "Some rows are dated outside the report's date range.",
  report_bad_input: "The report could not be read.",
};

export class UniteReportDbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniteReportDbError";
  }
}

function dbError(error: { message?: string }): UniteReportDbError {
  const known = error.message && DB_ERRORS[error.message];
  return new UniteReportDbError(known || "The database refused the request.");
}

const totals = (v: unknown): Record<ReconciledTotal, number> => {
  const o = (v ?? {}) as Record<string, unknown>;
  return Object.fromEntries(RECONCILED_TOTAL_KEYS.map((k) => [k, Number(o[k] ?? 0)])) as Record<
    ReconciledTotal,
    number
  >;
};

export function toUploadSummary(j: Json): UploadSummary {
  const o = j as Record<string, unknown>;
  return {
    uploadId: String(o.upload_id),
    existing: o.existing === true,
    status: o.status as UploadSummary["status"],
    fromDate: String(o.from_date),
    toDate: String(o.to_date),
    rowCount: Number(o.row_count ?? 0),
    reconciled: o.reconciled === true,
    reportTotals: totals(o.report_totals),
    rowTotals: totals(o.row_totals),
    problems: Array.isArray(o.problems) ? o.problems.map(String) : [],
    doctors: Number(o.doctors ?? 0),
    clinics: Number(o.clinics ?? 0),
    cancelledRows: Number(o.cancelled_rows ?? 0),
    unknownBranchRows: Number(o.unknown_branch_rows ?? 0),
  };
}

/** Parses the file (throws UniteReportError when it cannot be trusted) and stages the sanitised rows. */
export async function stageUniteReport(
  admin: AdminClient,
  input: { orgId: string; userId: string; buffer: Buffer },
): Promise<UploadSummary> {
  const parsed = await parseUniteReport(input.buffer);
  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const { data, error } = await admin.rpc("fin_report_stage", {
    p_org_id: input.orgId,
    p_user_id: input.userId,
    p_meta: {
      from_date: parsed.fromDate,
      to_date: parsed.toDate,
      file_sha256: sha256,
      report_totals: parsed.reportTotals,
      problems: parsed.problems,
      reconciled: parsed.reconciled,
    },
    p_rows: parsed.rows as unknown as Json,
  });
  if (error || !data) throw dbError(error ?? {});
  return toUploadSummary(data);
}

export async function loadUniteReportSummary(
  admin: AdminClient,
  orgId: string,
  uploadId: string,
): Promise<UploadSummary> {
  const { data, error } = await admin.rpc("fin_report_upload_summary", {
    p_org_id: orgId,
    p_upload_id: uploadId,
  });
  if (error || !data) throw dbError(error ?? {});
  return toUploadSummary(data);
}

export async function commitUniteReport(
  admin: AdminClient,
  input: { orgId: string; userId: string; uploadId: string },
): Promise<CommitResult> {
  const { data, error } = await admin.rpc("fin_report_commit", {
    p_org_id: input.orgId,
    p_upload_id: input.uploadId,
    p_user_id: input.userId,
  });
  if (error || !data) throw dbError(error ?? {});
  const o = data as Record<string, unknown>;
  return {
    rows: Number(o.rows ?? 0),
    superseded: Number(o.superseded ?? 0),
    unknownBranchRows: Number(o.unknown_branch_rows ?? 0),
  };
}

export async function discardUniteReport(
  admin: AdminClient,
  orgId: string,
  uploadId: string,
): Promise<{ rows: number }> {
  const { data, error } = await admin.rpc("fin_report_discard", {
    p_org_id: orgId,
    p_upload_id: uploadId,
  });
  if (error || !data) throw dbError(error ?? {});
  return { rows: Number((data as Record<string, unknown>).rows ?? 0) };
}

/** A message safe to show: the parser's and the database's own fixed sentences, else a generic one. */
export function safeReportMessage(err: unknown): string {
  if (err instanceof UniteReportError || err instanceof UniteReportDbError) return err.message;
  return "The file could not be processed. Check that it is the Unite Daily Collection report.";
}
