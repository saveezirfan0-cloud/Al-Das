import { fils, fromFils } from "@/lib/accounting/posting/lines";
import type { InvoiceShares } from "@/lib/finance/invoice-shares";

/**
 * Patient 360 billing summary (pure). One patient's invoices, who owes what on each (the invoice view's own split,
 * `invoiceShares`) and where the insurance claims stand. Ids and amounts only. Amounts are summed in fils.
 */

export type ClaimInput = {
  net: number | string | null;
  remitted: number | string | null;
  rejected: number | string | null;
};

/** Where the claims on one invoice stand. */
export type ClaimState =
  | "not_applicable" // self-pay or corporate: no insurer involved
  | "not_claimed" // insurance invoice, no claim matched yet
  | "awaiting" // claimed, nothing paid or rejected yet
  | "partly_paid" // something paid or rejected, the rest still open
  | "paid" // the insurer paid it all
  | "rejected"; // everything not paid was rejected

export const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  not_applicable: "No insurer",
  not_claimed: "Not claimed yet",
  awaiting: "Awaiting insurer",
  partly_paid: "Partly paid",
  paid: "Paid by insurer",
  rejected: "Rejected",
};

export function claimState(insurance: boolean, claims: readonly ClaimInput[]): ClaimState {
  if (!insurance) return "not_applicable";
  if (claims.length === 0) return "not_claimed";
  let net = 0;
  let remitted = 0;
  let rejected = 0;
  for (const c of claims) {
    net += fils(c.net);
    remitted += fils(c.remitted);
    rejected += fils(c.rejected);
  }
  if (remitted >= net && net > 0) return "paid";
  if (remitted + rejected >= net && rejected > 0) return "rejected";
  if (remitted + rejected > 0) return "partly_paid";
  return "awaiting";
}

export type BillingRow = {
  id: string;
  number: string | null;
  date: string | null;
  void: boolean;
  net: number | null;
  paid: number | null;
  claimed: number | null;
  /** The patient's (or company's) balance on this invoice; null when the shares could not be worked out. */
  balanceDue: number | null;
  claimState: ClaimState | null;
  insurerOutstanding: number | null;
};

export type BillingSummary = {
  /** What the patient still owes across the listed invoices (credits are not netted against other invoices). */
  patientDue: number;
  /** Credits: invoices the patient paid more than their share of. */
  patientCredit: number;
  insurerOutstanding: number;
  openInvoices: number;
  /** Invoices counted. */
  counted: number;
  /** Invoices left out because the claims permission is missing for an insurance invoice. */
  skipped: number;
  /** Claim counts by state, insurance invoices only. */
  claims: Partial<Record<ClaimState, number>>;
};

export function rowFromShares(
  base: Pick<BillingRow, "id" | "number" | "date" | "void" | "net" | "paid" | "claimed">,
  shares: InvoiceShares | null,
  claims: readonly ClaimInput[] | null,
): BillingRow {
  const insurance = shares ? shares.payerKind === "insurance" : true;
  return {
    ...base,
    balanceDue: shares ? shares.balanceDue : null,
    claimState: shares && claims ? claimState(insurance, claims) : null,
    insurerOutstanding: shares ? shares.insurerOutstanding : null,
  };
}

export function summarizeBilling(rows: readonly BillingRow[]): BillingSummary {
  let due = 0;
  let credit = 0;
  let insurer = 0;
  let open = 0;
  let counted = 0;
  let skipped = 0;
  const claims: Partial<Record<ClaimState, number>> = {};
  for (const r of rows) {
    if (r.void) continue;
    if (r.balanceDue === null) {
      skipped += 1;
      continue;
    }
    counted += 1;
    const b = fils(r.balanceDue);
    if (b > 0) {
      due += b;
      open += 1;
    } else if (b < 0) credit += -b;
    insurer += fils(r.insurerOutstanding);
    if (r.claimState && r.claimState !== "not_applicable")
      claims[r.claimState] = (claims[r.claimState] ?? 0) + 1;
  }
  return {
    patientDue: fromFils(due),
    patientCredit: fromFils(credit),
    insurerOutstanding: fromFils(insurer),
    openInvoices: open,
    counted,
    skipped,
    claims,
  };
}
