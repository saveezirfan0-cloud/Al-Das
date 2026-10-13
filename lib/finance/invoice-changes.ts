import { toCsv } from "@/lib/csv";

/**
 * The Unite invoice-change register (Phase 20J part 1, docs/20_PHASE_20J_NOTES.md). Pure.
 *
 * The change events come from SQL (public.fin_invoice_changes, migration 20261031000100): discounts, cancellations, credit
 * notes, write-offs and net reductions between Unite deliveries of an invoice, and refunds. This file reads that result
 * and holds the rules the page, the CSV and the actions share:
 *  - a change NEEDS an approval when its amount is at least change_review_min_amount (default 0: every change does);
 *  - a change is UNAPPROVED when it needs one, is dated on or after change_review_start_date, and has no review or was
 *    rejected ("explained" = a reviewer recorded why no approval was needed, e.g. a billing error corrected);
 *  - with no start date the register works but the measure is "not measured" (never shown as zero);
 *  - bulk approval covers unreviewed changes up to change_bulk_approve_max (0 = off).
 * Thresholds are settings (the authority matrix is open, OQ-96); nothing is hardcoded here.
 */

export const CHANGE_KINDS = [
  "discount",
  "cancellation",
  "credit_note",
  "write_off",
  "net_reduction",
  "refund",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const KIND_LABELS: Record<ChangeKind, string> = {
  discount: "Discount",
  cancellation: "Cancellation",
  credit_note: "Credit note",
  write_off: "Write-off",
  net_reduction: "Amount reduced",
  refund: "Refund",
};

export const DECISIONS = ["approved", "rejected", "explained"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Record<Decision, string> = {
  approved: "Approved",
  rejected: "Not approved",
  explained: "No approval needed (explained)",
};

export const REASON_MAX = 500;
/** The longest period one register query covers. */
export const MAX_PERIOD_DAYS = 366;
/** The most changes one bulk approval records. */
export const BULK_LIMIT = 500;

export type ChangeReview = {
  decision: Decision;
  reason: string;
  bulk: boolean;
  monthLocked: boolean;
  reviewedBy: string | null;
  reviewedAt: string;
};

export type ChangeEvent = {
  changeKey: string;
  invoiceId: string;
  invoiceNo: string;
  branch: string | null;
  doctorId: string | null;
  invType: string | null;
  kind: ChangeKind;
  amount: number;
  changeDate: string;
  uniteUser: string | null;
  monthLocked: boolean;
  review: ChangeReview | null;
};

export type ChangeRegister = {
  from: string;
  to: string;
  /** null = the measure is not switched on */
  startDate: string | null;
  minAmount: number;
  bulkMax: number;
  events: ChangeEvent[];
};

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown) => (v !== null && Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Reads the jsonb of fin_invoice_changes. Unknown kinds and decisions are dropped / read as no review (fail closed). */
export function parseChanges(raw: unknown): ChangeRegister {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(r.events) ? (r.events as Array<Record<string, unknown>>) : [];
  const events: ChangeEvent[] = [];
  for (const x of rows) {
    if (!(CHANGE_KINDS as readonly string[]).includes(String(x.kind))) continue;
    const rv = x.review as Record<string, unknown> | null | undefined;
    const review =
      rv && typeof rv === "object" && (DECISIONS as readonly string[]).includes(String(rv.decision))
        ? {
            decision: rv.decision as Decision,
            reason: String(rv.reason ?? ""),
            bulk: rv.bulk === true,
            monthLocked: rv.month_locked === true,
            reviewedBy: str(rv.reviewed_by),
            reviewedAt: String(rv.reviewed_at ?? ""),
          }
        : null;
    events.push({
      changeKey: String(x.change_key ?? ""),
      invoiceId: String(x.invoice_id ?? ""),
      invoiceNo: String(x.invoice_no ?? ""),
      branch: str(x.branch_code),
      doctorId: str(x.doctor_id),
      invType: str(x.inv_type),
      kind: x.kind as ChangeKind,
      amount: num(x.amount),
      changeDate: String(x.change_date ?? ""),
      uniteUser: str(x.unite_user),
      monthLocked: x.month_locked === true,
      review,
    });
  }
  return {
    from: String(r.from ?? ""),
    to: String(r.to ?? ""),
    startDate: str(r.start_date),
    minAmount: num(r.min_amount),
    bulkMax: num(r.bulk_max),
    events,
  };
}

type Thresholds = Pick<ChangeRegister, "startDate" | "minAmount">;

/** Does this change need an approval? (amount at or above the minimum; the default 0 means every change) */
export function needsApproval(e: Pick<ChangeEvent, "amount">, s: Pick<Thresholds, "minAmount">) {
  return e.amount >= s.minAmount;
}

/** Counted against "zero unapproved changes": needs approval, on or after the start date, not reviewed or rejected. */
export function isUnapproved(e: ChangeEvent, s: Thresholds): boolean {
  if (s.startDate === null || e.changeDate < s.startDate) return false;
  if (!needsApproval(e, s)) return false;
  return e.review === null || e.review.decision === "rejected";
}

export type CountAmount = { count: number; amount: number };

export type ChangeKpi =
  | { measured: false }
  | {
      measured: true;
      /** the first day counted: the later of the period start and the start date */
      from: string;
      awaiting: CountAmount;
      rejected: CountAmount;
      unapproved: CountAmount;
    };

/** The measure on the page: unapproved changes in the period, counted from the start date. */
export function changeKpi(reg: ChangeRegister): ChangeKpi {
  if (reg.startDate === null) return { measured: false };
  const awaiting = { count: 0, amount: 0 };
  const rejected = { count: 0, amount: 0 };
  for (const e of reg.events) {
    if (!isUnapproved(e, reg)) continue;
    const bucket = e.review === null ? awaiting : rejected;
    bucket.count++;
    bucket.amount = round2(bucket.amount + e.amount);
  }
  return {
    measured: true,
    from: reg.startDate > reg.from ? reg.startDate : reg.from,
    awaiting,
    rejected,
    unapproved: {
      count: awaiting.count + rejected.count,
      amount: round2(awaiting.amount + rejected.amount),
    },
  };
}

export type KindTotal = { kind: ChangeKind; count: number; amount: number; unreviewed: number };

/** Count, amount and unreviewed count per kind, in CHANGE_KINDS order (kinds with no change are left out). */
export function totalsByKind(events: readonly ChangeEvent[]): KindTotal[] {
  return CHANGE_KINDS.map((kind) => {
    const of = events.filter((e) => e.kind === kind);
    return {
      kind,
      count: of.length,
      amount: round2(of.reduce((a, e) => a + e.amount, 0)),
      unreviewed: of.filter((e) => e.review === null).length,
    };
  }).filter((t) => t.count > 0);
}

/** Changes a bulk approval would record: unreviewed, up to the bulk maximum (0 = none), optionally of one kind. */
export function bulkEligible(
  events: readonly ChangeEvent[],
  bulkMax: number,
  kind: ChangeKind | null = null,
): ChangeEvent[] {
  if (!(bulkMax > 0)) return [];
  return events
    .filter((e) => e.review === null && e.amount <= bulkMax && (kind === null || e.kind === kind))
    .slice(0, BULK_LIMIT);
}

/** Review order: unreviewed changes that need approval first, then other unreviewed, then reviewed; newest first within. */
export function reviewOrder(events: readonly ChangeEvent[], s: Thresholds): ChangeEvent[] {
  const rank = (e: ChangeEvent) => (e.review !== null ? 2 : needsApproval(e, s) ? 0 : 1);
  return [...events].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.changeDate < b.changeDate ? 1 : a.changeDate > b.changeDate ? -1 : 0) ||
      a.invoiceNo.localeCompare(b.invoiceNo) ||
      a.changeKey.localeCompare(b.changeKey),
  );
}

/** Status text for one change (page and CSV). */
export function statusLabel(e: ChangeEvent, s: Thresholds): string {
  if (e.review) return DECISION_LABELS[e.review.decision];
  return needsApproval(e, s) ? "Awaiting review" : "Below the approval amount";
}

/** A valid period: two dates, from <= to, at most MAX_PERIOD_DAYS days. */
export function periodProblem(from: string, to: string): string | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!re.test(from) || !re.test(to) || !Number.isFinite(a) || !Number.isFinite(b))
    return "Enter valid dates.";
  if (
    new Date(a).toISOString().slice(0, 10) !== from ||
    new Date(b).toISOString().slice(0, 10) !== to
  )
    return "Enter valid dates.";
  if (a > b) return "The start of the period is after its end.";
  if ((b - a) / 86_400_000 + 1 > MAX_PERIOD_DAYS)
    return `Choose a period of at most ${MAX_PERIOD_DAYS} days.`;
  return null;
}

/** The default period: the month so far. */
export function defaultPeriod(today: string): { from: string; to: string } {
  return { from: `${today.slice(0, 7)}-01`, to: today };
}

/** CSV: one row per change; ids, codes, amounts and the decision (the reason is the reviewer's own redacted text). */
export function changesCsv(reg: ChangeRegister, events: readonly ChangeEvent[]): string {
  return toCsv(
    [
      "Change date",
      "Invoice",
      "Branch",
      "Doctor ID",
      "Invoice type",
      "Change",
      "Amount (AED)",
      "Unite user",
      "Status",
      "Reason",
      "Bulk",
      "Reviewed at",
      "Month locked",
    ],
    events.map((e) => [
      e.changeDate,
      e.invoiceNo,
      e.branch ?? "",
      e.doctorId ?? "",
      e.invType ?? "",
      KIND_LABELS[e.kind],
      e.amount.toFixed(2),
      e.uniteUser ?? "",
      statusLabel(e, reg),
      e.review?.reason ?? "",
      e.review ? (e.review.bulk ? "yes" : "no") : "",
      e.review?.reviewedAt ? e.review.reviewedAt.slice(0, 16).replace("T", " ") : "",
      e.monthLocked ? "yes" : "no",
    ]),
  );
}
