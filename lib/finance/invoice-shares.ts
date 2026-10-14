import { splitReceivable } from "@/lib/accounting/posting/builders";
import { fils, fromFils } from "@/lib/accounting/posting/lines";
import { payerKindOf } from "@/lib/accounting/posting/rules";
import type { PayerKind } from "@/lib/accounting/posting/types";

/**
 * Who owes what on one Unite invoice (Phase G invoice view, pure). The split is the ledger's own (`splitReceivable`, the
 * rule the sales journal posts): on an insurance invoice the matched claims are the insurers' share per payer and the rest
 * is the patient's copay; before any claim is matched the whole total waits on the insurer. Write-offs and credit notes
 * reduce the same receivable the journal reduces (the largest claim, else the main one). The patient's balance due is
 * their share less what they paid (refunds added back); the insurers' outstanding is each share less what was remitted
 * and rejected. Amounts are summed in fils. Ids and amounts only: no patient identity.
 */

type Num = number | string | null | undefined;

export type InvoiceSharesInput = {
  invType: string | null;
  total: Num;
  writeOff: Num;
  creditNote: Num;
  /** Matched claim activities: amount = initial net (else net), as the sales journal reads them. */
  claims: ReadonlyArray<{ payerId: string | null; amount: Num; remitted: Num; rejected: Num }>;
  /** Unite payments; only current ones count. */
  payments: ReadonlyArray<{ paid: Num; refund: Num; isCurrent: boolean }>;
};

export type InsurerShare = {
  payerId: string | null;
  share: number;
  remitted: number;
  rejected: number;
  outstanding: number;
};

export type InvoiceShares = {
  payerKind: PayerKind;
  /** Who the non-insurer share belongs to: the patient, or the company on a corporate invoice. */
  mainParty: "patient" | "corporate";
  insurers: InsurerShare[];
  insurerShare: number;
  insurerOutstanding: number;
  patientShare: number;
  patientPaid: number;
  /** Positive: still owed by the patient (or company). Negative: paid more than their share (a credit). */
  balanceDue: number;
  /** Insurance invoice with no claim matched yet: the insurer share is the whole total and the payer is unknown. */
  claimsPending: boolean;
  /** The matched claims add up to more than the invoice (the ledger holds the posting). */
  claimsExceed: boolean;
  /** Write-off plus credit notes. */
  adjustments: number;
};

export function invoiceShares(input: InvoiceSharesInput): InvoiceShares {
  const payerKind = payerKindOf(input.invType);
  const total = fils(input.total);
  // one amount per payer, the way acc_posting_load groups them for the journal
  const byPayer = new Map<
    string,
    { payerId: string | null; amount: number; remitted: number; rejected: number }
  >();
  for (const c of input.claims) {
    const k = c.payerId ?? "";
    const row = byPayer.get(k) ?? { payerId: c.payerId, amount: 0, remitted: 0, rejected: 0 };
    row.amount += fils(c.amount);
    row.remitted += fils(c.remitted);
    row.rejected += fils(c.rejected);
    byPayer.set(k, row);
  }
  const split = splitReceivable(
    total,
    [...byPayer.values()].map((p) => ({ payer_id: p.payerId, amount: fromFils(p.amount) })),
    payerKind,
  );
  const adjustments = fils(input.writeOff) + fils(input.creditNote);
  const shares = split.insurers.map((s) => ({ ...s }));
  // claims above the invoice: the journal posts no patient share (it waits), so neither does this view
  let patient = split.exceeds ? 0 : split.patientFils;
  let pendingInsurer = split.insurers.length === 0 ? split.insurerFils : 0;
  if (split.adjustIndex !== null) shares[split.adjustIndex].fils -= adjustments;
  else if (payerKind === "insurance") pendingInsurer -= adjustments;
  else patient -= adjustments;

  const insurers: InsurerShare[] = shares.map((s) => {
    const p = byPayer.get(s.payerId ?? "");
    const remitted = p?.remitted ?? 0;
    const rejected = p?.rejected ?? 0;
    return {
      payerId: s.payerId,
      share: fromFils(s.fils),
      remitted: fromFils(remitted),
      rejected: fromFils(rejected),
      outstanding: fromFils(Math.max(0, s.fils - remitted - rejected)),
    };
  });
  if (payerKind === "insurance" && split.insurers.length === 0)
    insurers.push({
      payerId: null,
      share: fromFils(pendingInsurer),
      remitted: 0,
      rejected: 0,
      outstanding: fromFils(Math.max(0, pendingInsurer)),
    });

  let paid = 0;
  for (const p of input.payments) if (p.isCurrent) paid += fils(p.paid) - fils(p.refund);
  const insurerShare = insurers.reduce((a, s) => a + fils(s.share), 0);
  const insurerOutstanding = insurers.reduce((a, s) => a + fils(s.outstanding), 0);
  return {
    payerKind,
    mainParty: payerKind === "corporate" ? "corporate" : "patient",
    insurers,
    insurerShare: fromFils(insurerShare),
    insurerOutstanding: fromFils(insurerOutstanding),
    patientShare: fromFils(patient),
    patientPaid: fromFils(paid),
    balanceDue: fromFils(patient - paid),
    claimsPending: payerKind === "insurance" && split.insurers.length === 0,
    claimsExceed: split.exceeds,
    adjustments: fromFils(adjustments),
  };
}
