import "server-only";

import { createHash } from "node:crypto";

import { normalizeInvoiceNumber } from "@/lib/finance/keys";
import {
  reconcileRemittance,
  summariseReconciliation,
  type PriceRow,
  type ReconciledLine,
  type ReconciliationSummary,
  type RemitClaim,
} from "@/lib/finance/match-remittance";
import {
  parseRemittanceTable,
  readRemittanceFile,
  type RemitHeaderReport,
  type RemitLine,
  type RemitStats,
} from "@/lib/finance/parse-remittance";
import type { ValidationError } from "@/lib/finance/parse-diligence";
import { RemittanceFileError } from "@/lib/finance/parse-remittance-xml";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

/**
 * Payment advice workflow: stage -> preview -> commit. The uploaded file is read once and never kept (it can hold patient
 * names and member IDs); only the sanitised lines are staged, only its sha256 is remembered. Matching and the short-payment
 * rule are the pure functions in match-remittance.ts; this module only moves data.
 */

type J = NonNullable<Json>;
const chunk = <T>(arr: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const emptyHeader = (): RemitHeaderReport => ({
  recognised: 0,
  missingRequired: [],
  unrecognised: [],
  droppedSensitive: [],
  duplicateHeaders: [],
});

export type RemitStageOutcome =
  | { status: "duplicate"; fileId: string; committedAt: string | null }
  | {
      status: "rejected";
      fileId: string;
      errors: ValidationError[];
      totalErrors: number;
      header: RemitHeaderReport;
    }
  | { status: "staged"; fileId: string; header: RemitHeaderReport; stats: RemitStats };

export async function stageRemittance(
  admin: AdminClient,
  input: { orgId: string; userId: string; fileName: string; buffer: Buffer },
): Promise<RemitStageOutcome> {
  const sha = createHash("sha256").update(input.buffer).digest("hex");
  const { data: existing } = await admin
    .from("fin_raw_remittance_files")
    .select("id, status, committed_at, header_check, row_count, sum_paid")
    .eq("org_id", input.orgId)
    .eq("file_sha256", sha)
    .maybeSingle();
  if (existing?.status === "committed")
    return { status: "duplicate", fileId: existing.id, committedAt: existing.committed_at };
  if (existing?.status === "validated") {
    const lines = await loadStaged(admin, input.orgId, existing.id);
    return {
      status: "staged",
      fileId: existing.id,
      header: (existing.header_check as unknown as RemitHeaderReport) ?? emptyHeader(),
      stats: statsOf(lines),
    };
  }

  let fileId: string;
  if (existing) {
    fileId = existing.id; // a rejected upload of the same bytes: start again
    await admin.from("fin_staged_remittance_lines").delete().eq("file_id", fileId);
    await admin
      .from("fin_raw_remittance_files")
      .update({
        file_name: input.fileName.slice(0, 200),
        uploaded_by: input.userId,
        status: "rejected",
        errors: [{ row: null, code: "incomplete" }] as J,
      })
      .eq("id", fileId);
  } else {
    const { data, error } = await admin
      .from("fin_raw_remittance_files")
      .insert({
        org_id: input.orgId,
        file_name: input.fileName.slice(0, 200),
        file_sha256: sha,
        uploaded_by: input.userId,
        status: "rejected",
        errors: [{ row: null, code: "incomplete" }] as J,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`create file: ${error?.code ?? "unknown"}`);
    fileId = data.id;
  }

  const reject = async (
    errors: ValidationError[],
    total: number,
    header: RemitHeaderReport,
  ): Promise<RemitStageOutcome> => {
    await admin
      .from("fin_raw_remittance_files")
      .update({
        status: "rejected",
        header_check: header as unknown as J,
        errors: errors as unknown as J,
      })
      .eq("id", fileId);
    return { status: "rejected", fileId, errors, totalErrors: total, header };
  };

  let table: unknown[][];
  try {
    table = await readRemittanceFile(input.buffer);
  } catch (e) {
    const code = e instanceof RemittanceFileError ? e.code : "unreadable_file";
    return reject([{ row: null, code }], 1, emptyHeader());
  }
  const parsed = parseRemittanceTable(table);
  if (!parsed.ok) return reject(parsed.errors, parsed.totalErrors, parsed.header);

  for (const part of chunk(
    parsed.rows.map((data, i) => ({
      org_id: input.orgId,
      file_id: fileId,
      row_no: i + 2,
      data: data as unknown as J,
    })),
    500,
  )) {
    const { error } = await admin.from("fin_staged_remittance_lines").insert(part);
    if (error) throw new Error(`stage rows: ${error.code ?? "unknown"}`);
  }
  await admin
    .from("fin_raw_remittance_files")
    .update({
      status: "validated",
      row_count: parsed.stats.rows,
      sum_paid: parsed.stats.sumPaid,
      header_check: parsed.header as unknown as J,
      errors: [] as J,
    })
    .eq("id", fileId);
  return { status: "staged", fileId, header: parsed.header, stats: parsed.stats };
}

function statsOf(rows: RemitLine[]): RemitStats {
  const dates = rows
    .map((r) => r.paid_on)
    .filter((d): d is string => !!d)
    .sort();
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    rows: rows.length,
    sumPaid: r2(rows.reduce((a, r) => a + r.paid_amount, 0)),
    sumDenied: r2(rows.reduce((a, r) => a + r.denied_amount, 0)),
    minPaidOn: dates[0] ?? null,
    maxPaidOn: dates.at(-1) ?? null,
    refs: new Set(rows.map((r) => r.remittance_ref)).size,
  };
}

async function loadStaged(admin: AdminClient, orgId: string, fileId: string): Promise<RemitLine[]> {
  const out: RemitLine[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin
      .from("fin_staged_remittance_lines")
      .select("row_no, data")
      .eq("org_id", orgId)
      .eq("file_id", fileId)
      .order("row_no")
      .range(from, from + 999);
    if (error) throw new Error(`load staged: ${error.code ?? "unknown"}`);
    for (const r of data ?? []) out.push(r.data as unknown as RemitLine);
    if ((data?.length ?? 0) < 1000) break;
  }
  return out;
}

/**
 * The candidate claims, each with `paid_before`: what earlier COMMITTED advice already paid on it (negative take-back
 * lines netted, never below 0), leaving out the file being previewed or committed, so a completing payment is not short
 * and a second full payment is overpaid (ins_claims_for_remittance, 20261223000100).
 */
async function claimsFor(
  admin: AdminClient,
  orgId: string,
  lines: readonly RemitLine[],
  excludeFileId: string,
): Promise<RemitClaim[]> {
  const numbers = [
    ...new Set(lines.map((l) => l.claim_activity_number).filter((x): x is string => !!x)),
  ];
  const keys = [
    ...new Set(
      lines
        .filter((l) => !l.claim_activity_number && l.invoice_no)
        .map((l) => normalizeInvoiceNumber(l.invoice_no)),
    ),
  ];
  const byId = new Map<string, RemitClaim>();
  const calls: Array<[string[], string[]]> = [
    ...chunk(numbers, 1000).map((n): [string[], string[]] => [n, []]),
    ...chunk(keys, 1000).map((k): [string[], string[]] => [[], k]),
  ];
  for (const [n, k] of calls) {
    const { data, error } = await admin.rpc("ins_claims_for_remittance", {
      p_org_id: orgId,
      p_numbers: n,
      p_invoice_keys: k,
      p_exclude_file_id: excludeFileId,
    });
    if (error) throw new Error(`claims: ${error.code ?? "unknown"}`);
    for (const c of (data ?? []) as unknown as RemitClaim[])
      byId.set(c.id, {
        ...c,
        quantity: c.quantity == null ? null : Number(c.quantity),
        net: c.net == null ? null : Number(c.net),
        paid_before: c.paid_before == null ? null : Number(c.paid_before),
      });
  }
  return [...byId.values()];
}

async function pricesFor(
  admin: AdminClient,
  orgId: string,
  lines: readonly RemitLine[],
  claims: readonly RemitClaim[],
): Promise<PriceRow[]> {
  const payers = [
    ...new Set(
      [...lines.map((l) => l.payer_id), ...claims.map((c) => c.payer_id)].filter(
        (p): p is string => !!p,
      ),
    ),
  ];
  if (payers.length === 0) return [];
  const out: PriceRow[] = [];
  for (const part of chunk(payers, 100)) {
    for (let from = 0; ; from += 1000) {
      const { data } = await admin
        .from("fin_ref_payer_prices")
        .select("payer_id, cpt_code, agreed_price, effective_from, effective_to")
        .eq("org_id", orgId)
        .in("payer_id", part)
        .range(from, from + 999);
      for (const p of data ?? [])
        out.push({
          payer_id: p.payer_id,
          cpt_code: p.cpt_code,
          agreed_price: Number(p.agreed_price),
          effective_from: p.effective_from,
          effective_to: p.effective_to,
        });
      if ((data?.length ?? 0) < 1000) break;
    }
  }
  return out;
}

export type RemitPreview = {
  fileId: string;
  status: "validated" | "committed" | "rejected";
  header: RemitHeaderReport;
  stats: RemitStats;
  summary: ReconciliationSummary;
  /** Lines needing attention (short, unmatched, ambiguous, overpaid), capped. Identifiers and amounts only. */
  attention: Array<
    Pick<
      ReconciledLine,
      | "row_no"
      | "claim_activity_number"
      | "invoice_no"
      | "cpt_code"
      | "paid_amount"
      | "expected_amount"
      | "short_amount"
      | "match_status"
      | "flags"
    >
  >;
  pricedLines: number;
};

async function reconcileFile(admin: AdminClient, orgId: string, fileId: string) {
  const { data: file } = await admin
    .from("fin_raw_remittance_files")
    .select("id, status, header_check")
    .eq("org_id", orgId)
    .eq("id", fileId)
    .maybeSingle();
  if (!file) return null;
  const lines = await loadStaged(admin, orgId, fileId);
  const settings = await loadFinanceSettings(admin, orgId);
  const claims = await claimsFor(admin, orgId, lines, fileId);
  const prices = await pricesFor(admin, orgId, lines, claims);
  const rows = reconcileRemittance(lines, claims, prices, {
    toleranceAmount: settings.shortPayToleranceAmount,
    tolerancePct: settings.shortPayTolerancePct,
  });
  return { file, lines, rows };
}

export async function buildRemittancePreview(
  admin: AdminClient,
  orgId: string,
  fileId: string,
): Promise<RemitPreview | null> {
  const r = await reconcileFile(admin, orgId, fileId);
  if (!r) return null;
  const attention = r.rows
    .filter(
      (x) =>
        x.match_status !== "matched" ||
        x.flags.some(
          (f) =>
            f === "short_paid" ||
            f === "overpaid" ||
            f === "payer_mismatch" ||
            f === "duplicate_in_file",
        ),
    )
    .slice(0, 100)
    .map((x) => ({
      row_no: x.row_no,
      claim_activity_number: x.claim_activity_number,
      invoice_no: x.invoice_no,
      cpt_code: x.cpt_code,
      paid_amount: x.paid_amount,
      expected_amount: x.expected_amount,
      short_amount: x.short_amount,
      match_status: x.match_status,
      flags: x.flags,
    }));
  return {
    fileId,
    status: r.file.status as RemitPreview["status"],
    header: (r.file.header_check as unknown as RemitHeaderReport) ?? emptyHeader(),
    stats: statsOf(r.lines),
    summary: summariseReconciliation(r.rows),
    attention,
    pricedLines: r.rows.filter((x) => x.expected_basis === "price_list").length,
  };
}

export async function commitRemittance(
  admin: AdminClient,
  input: { orgId: string; userId: string; fileId: string },
): Promise<{
  batchId: string;
  lines: number;
  duplicatesSkipped: number;
  summary: ReconciliationSummary;
}> {
  const r = await reconcileFile(admin, input.orgId, input.fileId);
  if (!r) throw new Error("file not found");
  if (r.file.status !== "validated")
    throw new Error(`file is ${r.file.status} and cannot be committed`);
  if (r.rows.length === 0)
    throw new Error("no staged lines (the preview expired); upload the file again");
  const refs = new Set(r.lines.map((l) => l.remittance_ref));
  const payers = new Set(r.lines.map((l) => l.payer_id).filter(Boolean));
  const dates = r.lines
    .map((l) => l.paid_on)
    .filter((d): d is string => !!d)
    .sort();
  const batch = {
    remittance_ref: refs.size === 1 ? [...refs][0] : null,
    payer_id: payers.size === 1 ? [...payers][0] : null,
    paid_on: dates.at(-1) ?? null,
  };
  const { data, error } = await admin.rpc("ins_commit_remittance", {
    p_org_id: input.orgId,
    p_file_id: input.fileId,
    p_user_id: input.userId,
    p_batch: batch as unknown as J,
    p_lines: r.rows as unknown as J,
  });
  if (error)
    throw new Error(
      error.message.includes("cannot be committed")
        ? "That file was already committed."
        : "The reconciliation could not be saved.",
    );
  const res = data as { batch_id: string; lines: number; duplicates_skipped: number };
  return {
    batchId: res.batch_id,
    lines: res.lines,
    duplicatesSkipped: res.duplicates_skipped,
    summary: summariseReconciliation(r.rows),
  };
}

export async function discardRemittance(
  admin: AdminClient,
  orgId: string,
  fileId: string,
): Promise<void> {
  await admin
    .from("fin_staged_remittance_lines")
    .delete()
    .eq("org_id", orgId)
    .eq("file_id", fileId);
  await admin
    .from("fin_raw_remittance_files")
    .update({ status: "rejected", errors: [{ row: null, code: "discarded" }] as J })
    .eq("org_id", orgId)
    .eq("id", fileId)
    .eq("status", "validated");
}
