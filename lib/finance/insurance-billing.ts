import { z } from "zod";

import { coverageOf, type Coverage, type DateRange } from "@/lib/finance/doctor-performance";
import { normalizeInvoiceNumber } from "@/lib/finance/keys";

/**
 * Insurance billed vs claimed (Phase 23D-2, docs/23_PHASE_23D2_NOTES.md). Pure and deterministic.
 *
 * BILLED is what the Unite collection report says was billed to insurers (insurance_claim per insurance invoice
 * number); SUBMITTED is what Diligence holds for that invoice number (ins_claim_activities). The sums come from
 * public.fin_insurance_billing_recon_inputs() (SQL); the buckets are decided here:
 *
 *   ambiguous            the month's report gives the invoice number more than one (branch, doctor): listed, never
 *                        paired, whatever Diligence holds
 *   matched              Diligence has the number; flagged when |billed − submitted| is MORE than the tolerance
 *   billed not submitted no Diligence activity, billed > 0 and MORE than `graceDays` days since the report date
 *                        (the latest report date of the invoice's rows); inside the grace period it is "awaiting"
 *   submitted, not in the report
 *                        Diligence activities dated this month whose number is on no row of this month's report
 *                        (the SQL decides; only for members who see every branch, with no branch filter)
 *
 * The invoice-number rule is normalizeInvoiceNumber() (lib/finance/keys.ts: upper case, whitespace removed), the same
 * as fin_invoices.inv_key; SQL uses its twin app.fin_invoice_key() (parity-tested). Amounts are compared in fils
 * (thousandths, as Unite keeps them), so float noise never moves a tolerance edge.
 */

/** The one invoice-number rule (re-exported so this module's callers and tests name it once). */
export const invoiceKey = normalizeInvoiceNumber;

export type ReconSettings = { tolerance: number; graceDays: number };
export const DEFAULT_RECON_SETTINGS: ReconSettings = { tolerance: 1, graceDays: 7 };

export type ReconPair = { branch: string | null; doctor: string };

export type BilledInvoice = {
  key: string;
  invoiceNo: string;
  billed: number;
  rows: number;
  firstDate: string;
  lastDate: string;
  /** Distinct (branch, doctor) on this month's report rows, over every branch. */
  pairs: number;
  /** The pairs within the member's branches (what the page may show). */
  visiblePairs: ReconPair[];
  /** Diligence net for the number; null when Diligence has no activity for it. */
  submitted: number | null;
  activities: number;
  payers: string[];
};

export type UnreportedInvoice = {
  key: string;
  invoiceNo: string;
  submitted: number;
  activities: number;
  firstDate: string | null;
  payers: string[];
  /** The latest month whose report has the number on a not cancelled row; null when none. */
  reportMonth: string | null;
  cancelledInReport: boolean;
};

export type ReconSummaryInput = {
  billed: number;
  billedRows: number;
  noInvoiceNoRows: number;
  noInvoiceNoAmount: number;
  cancelledRows: number;
  cancelledAmount: number;
  submittedNoInvoiceNoActivities: number;
  submittedNoInvoiceNoAmount: number;
};

export type ReconInputs = {
  month: string;
  branch: string | null;
  unreportedShown: boolean;
  coverage: DateRange[];
  settings: ReconSettings;
  summary: ReconSummaryInput;
  invoices: BilledInvoice[];
  unreported: UnreportedInvoice[];
};

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {};
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);
const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const textOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseReconInputs(raw: unknown): ReconInputs {
  const r = obj(raw);
  const s = obj(r.settings);
  const m = obj(r.summary);
  const tolerance = Number(s.tolerance);
  const grace = Number(s.grace_days);
  return {
    month: str(r.month),
    branch: textOrNull(r.branch),
    unreportedShown: r.unreported_shown === true,
    coverage: arr(r.coverage)
      .map((x) => ({ from: str(x.from), to: str(x.to) }))
      .filter((x) => ISO.test(x.from) && ISO.test(x.to)),
    settings: {
      tolerance:
        Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_RECON_SETTINGS.tolerance,
      graceDays: Number.isInteger(grace) && grace >= 0 ? grace : DEFAULT_RECON_SETTINGS.graceDays,
    },
    summary: {
      billed: n(m.billed),
      billedRows: n(m.billed_rows),
      noInvoiceNoRows: n(m.no_invoice_no_rows),
      noInvoiceNoAmount: n(m.no_invoice_no_amount),
      cancelledRows: n(m.cancelled_rows),
      cancelledAmount: n(m.cancelled_amount),
      submittedNoInvoiceNoActivities: n(m.submitted_no_invoice_no_activities),
      submittedNoInvoiceNoAmount: n(m.submitted_no_invoice_no_amount),
    },
    invoices: arr(r.invoices).map((x) => ({
      key: str(x.key),
      invoiceNo: str(x.invoice_no) || str(x.key),
      billed: n(x.billed),
      rows: n(x.rows),
      firstDate: str(x.first_date),
      lastDate: str(x.last_date),
      pairs: n(x.pairs),
      visiblePairs: arr(x.visible_pairs).map((p) => ({
        branch: textOrNull(p.branch),
        doctor: str(p.doctor),
      })),
      submitted: x.submitted === null || x.submitted === undefined ? null : n(x.submitted),
      activities: n(x.activities),
      payers: strings(x.payers),
    })),
    unreported: arr(r.unreported).map((x) => ({
      key: str(x.key),
      invoiceNo: str(x.invoice_no) || str(x.key),
      submitted: n(x.submitted),
      activities: n(x.activities),
      firstDate: textOrNull(x.first_date),
      payers: strings(x.payers),
      reportMonth: textOrNull(x.report_month),
      cancelledInReport: x.cancelled_in_report === true,
    })),
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Thousandths (fils, as Unite keeps them): every comparison and sum is done in whole fils. */
const fils = (v: number) => Math.round(v * 1000);
const aedOf = (f: number) => f / 1000;

/** Whole days from `from` to `to` (both yyyy-mm-dd). */
export function daysBetween(from: string, to: string): number {
  const d = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  return Math.round((d(to) - d(from)) / 86_400_000);
}

export type Bucket =
  "ambiguous" | "matched" | "billed_not_submitted" | "awaiting" | "nothing_to_claim";

/** The bucket of one billed invoice number on `asOf` (yyyy-mm-dd, the org's today). */
export function classifyInvoice(inv: BilledInvoice, s: ReconSettings, asOf: string): Bucket {
  if (inv.pairs > 1) return "ambiguous";
  if (inv.submitted !== null && inv.activities > 0) return "matched";
  if (fils(inv.billed) <= 0) return "nothing_to_claim";
  return daysBetween(inv.lastDate, asOf) > s.graceDays ? "billed_not_submitted" : "awaiting";
}

/** Billed − submitted, in AED (exact to the fil); flagged when its size is MORE than the tolerance. */
export function difference(billed: number, submitted: number, s: ReconSettings) {
  const diff = fils(billed) - fils(submitted);
  return { difference: aedOf(diff), flagged: Math.abs(diff) > fils(s.tolerance) };
}

export type MatchedRow = BilledInvoice & {
  submitted: number;
  difference: number;
  flagged: boolean;
};
export type AtRiskRow = BilledInvoice & { ageDays: number };
export type UnreportedNote = "other_month" | "cancelled" | "not_in_report";
export type UnreportedRow = UnreportedInvoice & { note: UnreportedNote };

export const UNREPORTED_NOTE: Record<UnreportedNote, string> = {
  other_month: "Check the month: in another month's report",
  cancelled: "Check the month: cancelled in the report",
  not_in_report: "Check the month: not in any uploaded report",
};

export type InsuranceBillingRecon = {
  month: string;
  branch: string | null;
  asOf: string;
  settings: ReconSettings;
  coverage: Coverage;
  unreportedShown: boolean;
  /** Billed with a submission, flagged differences first (largest first). */
  matched: MatchedRow[];
  /** Past the grace period with no submission: the money at risk, oldest first. */
  billedNotSubmitted: AtRiskRow[];
  /** Inside the grace period with no submission yet. */
  awaiting: AtRiskRow[];
  ambiguous: BilledInvoice[];
  unreported: UnreportedRow[];
  summary: {
    billed: number;
    /** Diligence net on this month's billed invoice numbers (matched and ambiguous). */
    submitted: number;
    /** Billed AED on invoice numbers Diligence has (matched only) ÷ billed AED; null when nothing was billed. */
    matchedPct: number | null;
    atRisk: number;
    atRiskCount: number;
    awaitingAmount: number;
    awaitingCount: number;
    matchedCount: number;
    flaggedCount: number;
    flaggedDifference: number;
    ambiguousCount: number;
    unreportedCount: number;
    unreportedAmount: number;
  } & Pick<
    ReconSummaryInput,
    | "billedRows"
    | "noInvoiceNoRows"
    | "noInvoiceNoAmount"
    | "cancelledRows"
    | "cancelledAmount"
    | "submittedNoInvoiceNoActivities"
    | "submittedNoInvoiceNoAmount"
  >;
  hasData: boolean;
};

const byInvoice = (a: { invoiceNo: string }, b: { invoiceNo: string }) =>
  a.invoiceNo < b.invoiceNo ? -1 : a.invoiceNo > b.invoiceNo ? 1 : 0;

export function buildInsuranceBilling(inputs: ReconInputs, asOf: string): InsuranceBillingRecon {
  const s = inputs.settings;
  const matched: MatchedRow[] = [];
  const late: AtRiskRow[] = [];
  const awaiting: AtRiskRow[] = [];
  const ambiguous: BilledInvoice[] = [];
  let submittedF = 0;
  let matchedBilledF = 0;

  for (const inv of inputs.invoices) {
    const bucket = classifyInvoice(inv, s, asOf);
    if (bucket === "ambiguous") {
      ambiguous.push(inv);
      submittedF += fils(inv.submitted ?? 0);
    } else if (bucket === "matched") {
      const submitted = inv.submitted as number;
      matched.push({ ...inv, submitted, ...difference(inv.billed, submitted, s) });
      submittedF += fils(submitted);
      matchedBilledF += fils(inv.billed);
    } else if (bucket === "billed_not_submitted" || bucket === "awaiting") {
      const row = { ...inv, ageDays: daysBetween(inv.lastDate, asOf) };
      (bucket === "awaiting" ? awaiting : late).push(row);
    }
  }

  matched.sort(
    (a, b) =>
      Number(b.flagged) - Number(a.flagged) ||
      Math.abs(fils(b.difference)) - Math.abs(fils(a.difference)) ||
      byInvoice(a, b),
  );
  const oldest = (a: AtRiskRow, b: AtRiskRow) =>
    b.ageDays - a.ageDays || fils(b.billed) - fils(a.billed) || byInvoice(a, b);
  late.sort(oldest);
  awaiting.sort(oldest);
  ambiguous.sort(byInvoice);

  const unreported: UnreportedRow[] = (inputs.unreportedShown ? inputs.unreported : [])
    .map((u) => ({
      ...u,
      note: (u.reportMonth
        ? "other_month"
        : u.cancelledInReport
          ? "cancelled"
          : "not_in_report") as UnreportedNote,
    }))
    .sort((a, b) => fils(b.submitted) - fils(a.submitted) || byInvoice(a, b));

  const sumF = (list: { billed: number }[]) => list.reduce((t, x) => t + fils(x.billed), 0);
  const flagged = matched.filter((m) => m.flagged);
  const sm = inputs.summary;
  const billedF = fils(sm.billed);

  return {
    month: inputs.month,
    branch: inputs.branch,
    asOf,
    settings: s,
    coverage: coverageOf(inputs.month, inputs.coverage),
    unreportedShown: inputs.unreportedShown,
    matched,
    billedNotSubmitted: late,
    awaiting,
    ambiguous,
    unreported,
    summary: {
      billedRows: sm.billedRows,
      noInvoiceNoRows: sm.noInvoiceNoRows,
      noInvoiceNoAmount: sm.noInvoiceNoAmount,
      cancelledRows: sm.cancelledRows,
      cancelledAmount: sm.cancelledAmount,
      // activities carry no branch: shown only with the unreported list
      submittedNoInvoiceNoActivities: inputs.unreportedShown
        ? sm.submittedNoInvoiceNoActivities
        : 0,
      submittedNoInvoiceNoAmount: inputs.unreportedShown ? sm.submittedNoInvoiceNoAmount : 0,
      billed: aedOf(billedF),
      submitted: aedOf(submittedF),
      matchedPct: billedF > 0 ? matchedBilledF / billedF : null,
      atRisk: aedOf(sumF(late)),
      atRiskCount: late.length,
      awaitingAmount: aedOf(sumF(awaiting)),
      awaitingCount: awaiting.length,
      matchedCount: matched.length,
      flaggedCount: flagged.length,
      flaggedDifference: aedOf(flagged.reduce((t, m) => t + fils(m.difference), 0)),
      ambiguousCount: ambiguous.length,
      unreportedCount: unreported.length,
      unreportedAmount: aedOf(unreported.reduce((t, u) => t + fils(u.submitted), 0)),
    },
    hasData:
      inputs.invoices.length > 0 ||
      unreported.length > 0 ||
      inputs.summary.billedRows > 0 ||
      inputs.summary.cancelledRows > 0,
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** The two thresholds, as the settings form posts them. Same limits as the database check. */
export const reconSettingsSchema = z.object({
  ins_recon_tolerance: z.coerce
    .number({ message: "Tolerance must be a number." })
    .min(0, "Tolerance cannot be negative.")
    .max(100_000, "Tolerance must be at most 100,000.")
    .refine(
      (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      "Tolerance: at most two decimals.",
    ),
  ins_recon_grace_days: z.coerce
    .number({ message: "Grace days must be a number." })
    .int("Grace days must be a whole number.")
    .min(0, "Grace days cannot be negative.")
    .max(365, "Grace days must be at most 365."),
});
