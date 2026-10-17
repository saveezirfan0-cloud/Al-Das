/**
 * One status per insurance claim, from treatment to closure (pure). The inputs are the claim's own figures (Diligence
 * claim row: net, remitted, rejected, write-off, resubmissions) plus two facts Pulse holds elsewhere: payments taken back
 * (negative advice lines, see match-remittance.ts) and the outcome of the claim's denial case. It reads only; it never
 * changes a claim (Diligence stays the source of truth), and unknown or blank figures give `unknown` rather than a guess.
 *
 *   submitted      sent, nothing back yet
 *   under_review   the payer has accepted it for processing (Diligence status in accepted_claim_statuses), nothing paid
 *   partly_paid    something paid, something still open
 *   rejected       nothing paid and the payer rejected it
 *   resubmitted    sent again after the last advice: waiting for the answer (wins over partly_paid / rejected)
 *   taken_back     paid, then recouped, and open again
 *   paid           paid in full, bank receipt not confirmed
 *   closed         paid in full and received in the bank, or the denial case was lost
 *   written_off    the open balance is covered by an approved write-off, or the denial case was written off
 *
 * The tolerance is the short-payment tolerance amount from fin_ref_finance_settings (passed in, never a constant here).
 * `overpaid` is reported next to the status (a duplicate or late second payment), not as a status of its own.
 */

export const CLAIM_STATUSES = [
  "submitted",
  "under_review",
  "partly_paid",
  "rejected",
  "resubmitted",
  "taken_back",
  "paid",
  "closed",
  "written_off",
  "unknown",
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  submitted: "Submitted",
  under_review: "Under review",
  partly_paid: "Partly paid",
  rejected: "Rejected",
  resubmitted: "Resubmitted",
  taken_back: "Payment taken back",
  paid: "Paid",
  closed: "Closed",
  written_off: "Written off",
  unknown: "Unknown",
};

export type DenialOutcome = "none" | "open" | "lost" | "written_off";

export type ClaimFacts = {
  net: number | null;
  /** Payments received for the claim (gross of anything taken back). */
  remitted: number | null;
  rejected: number | null;
  writeOff: number | null;
  writeOffApproved: boolean;
  /** Total of the claim's negative advice lines, as a positive number. */
  takenBack: number | null;
  resubmissionCount: number | null;
  lastResubmissionDate: string | null;
  lastRemittanceDate: string | null;
  accepted: boolean;
  bankReceived: boolean;
  denialOutcome: DenialOutcome;
};

export type ClaimStatusResult = {
  status: ClaimStatus;
  /** What the payer still owes after payments, take-backs and an approved write-off (never negative). */
  outstanding: number;
  /** Paid beyond the claim (a duplicate or second payment); 0 when none. */
  overpaid: number;
};

const cents = (n: number) => Math.round(n * 100);
const orZero = (n: number | null) => (n === null ? 0 : n);
const finite = (n: number | null) => n === null || Number.isFinite(n);

export function claimStatus(f: ClaimFacts, tolerance: number): ClaimStatusResult {
  const unknown: ClaimStatusResult = { status: "unknown", outstanding: 0, overpaid: 0 };
  if (f.net === null || !Number.isFinite(f.net) || f.net <= 0) return unknown;
  if (![f.remitted, f.rejected, f.writeOff, f.takenBack, f.resubmissionCount].every(finite))
    return unknown;
  if (!Number.isFinite(tolerance) || tolerance < 0) return unknown;

  const tol = cents(tolerance);
  const net = cents(f.net);
  const takenBack = cents(orZero(f.takenBack));
  const paid = cents(orZero(f.remitted)) - takenBack;
  const writeOff = f.writeOffApproved ? cents(orZero(f.writeOff)) : 0;
  const open = net - paid - writeOff;
  const outstanding = Math.max(0, open) / 100;
  const overpaid = -open > tol ? -open / 100 : 0;
  const out = (status: ClaimStatus): ClaimStatusResult => ({ status, outstanding, overpaid });

  if (open <= tol) {
    if (writeOff > 0 && paid < net - tol) return out("written_off");
    return out(f.bankReceived ? "closed" : "paid");
  }
  if (takenBack > tol) return out("taken_back");
  if (f.denialOutcome === "written_off") return out("written_off");
  if (f.denialOutcome === "lost") return out("closed");

  const resubmittedAfterAdvice =
    orZero(f.resubmissionCount) > 0 &&
    !!f.lastResubmissionDate &&
    (!f.lastRemittanceDate || f.lastRemittanceDate < f.lastResubmissionDate);
  if (resubmittedAfterAdvice) return out("resubmitted");
  if (paid > tol) return out("partly_paid");
  if (cents(orZero(f.rejected)) > tol) return out("rejected");
  return out(f.accepted ? "under_review" : "submitted");
}

/**
 * How many whole calendar months after the service month the money arrived (0 = the same month; negative = paid before
 * the service month, which is data to look at). Null when either date is missing. A late advice is not an error: most
 * insurer money arrives one or two months after the visit, so this only says which month the cash belongs to.
 */
export function settlementMonthOffset(
  serviceDate: string | null,
  paidOn: string | null,
): number | null {
  const m = (d: string | null) => {
    const x = /^(\d{4})-(\d{2})-\d{2}$/.exec(d ?? "");
    return x ? Number(x[1]) * 12 + Number(x[2]) : null;
  };
  const a = m(serviceDate);
  const b = m(paidOn);
  return a === null || b === null ? null : b - a;
}
