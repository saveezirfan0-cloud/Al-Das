/**
 * Phase G: who owes what on a Unite invoice (pure). The split must be the ledger's own (splitReceivable is what the sales
 * journal posts), so the invoice page and the books never disagree. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  buildUniteInvoice,
  splitReceivable,
  type UniteInvoiceRecord,
} from "@/lib/accounting/posting/builders";
import { parseContext, type PostingContext } from "@/lib/accounting/posting/types";
import { invoiceShares } from "@/lib/finance/invoice-shares";

import contextJson from "../accounting/posting/context.synthetic.json";
import sources from "../accounting/posting/sources.synthetic.json";

const ctx: PostingContext = parseContext(contextJson);

describe("splitReceivable", () => {
  it("leaves a self-pay or corporate invoice wholly with the patient or the company", () => {
    expect(splitReceivable(50_000, [{ payer_id: "P1", amount: 100 }], "self_pay")).toMatchObject({
      insurers: [],
      insurerFils: 0,
      patientFils: 50_000,
      adjustIndex: null,
    });
    expect(splitReceivable(50_000, [], "corporate").patientFils).toBe(50_000);
  });

  it("puts the whole insurance total on the insurer until a claim is matched", () => {
    expect(splitReceivable(50_000, [{ payer_id: "P1", amount: 0 }], "insurance")).toMatchObject({
      insurers: [],
      insurerFils: 50_000,
      patientFils: 0,
      exceeds: false,
    });
  });

  it("orders payers, picks the largest claim for adjustments and flags claims above the invoice", () => {
    const s = splitReceivable(
      50_000,
      [
        { payer_id: "P2", amount: 150 },
        { payer_id: "P1", amount: "300.00" },
      ],
      "insurance",
    );
    expect(s.insurers).toEqual([
      { payerId: "P1", fils: 30_000 },
      { payerId: "P2", fils: 15_000 },
    ]);
    expect(s).toMatchObject({
      insurerFils: 45_000,
      patientFils: 5_000,
      adjustIndex: 0,
      exceeds: false,
    });
    expect(splitReceivable(10_000, [{ payer_id: "P1", amount: 150 }], "insurance").exceeds).toBe(
      true,
    );
  });
});

describe("invoiceShares", () => {
  it("matches the sales journal's receivable lines for the synthetic insurance invoice", () => {
    const rec = sources.insuranceInvoice as UniteInvoiceRecord;
    const r = buildUniteInvoice(rec, ctx);
    if (r.action !== "post") throw new Error("expected a posting");
    const debitByPayer = new Map<string, number>();
    for (const l of r.journal.lines)
      if (["1200", "1201", "1210"].includes(l.account_code ?? ""))
        debitByPayer.set(l.payer_id ?? "patient", Number(l.debit ?? 0));
    const s = invoiceShares({
      invType: rec.inv_type,
      total: rec.total,
      writeOff: rec.write_off,
      creditNote: rec.credit_note,
      claims: rec.claims.map((c) => ({
        payerId: c.payer_id,
        amount: c.amount,
        remitted: 0,
        rejected: 0,
      })),
      payments: [],
    });
    expect(s.insurers.map((i) => [i.payerId, i.share])).toEqual([
      ["PAYER-SYN-1", debitByPayer.get("PAYER-SYN-1")],
      ["PAYER-SYN-2", debitByPayer.get("PAYER-SYN-2")],
    ]);
    expect(s.patientShare).toBe(debitByPayer.get("patient"));
    expect(s.adjustments).toBe(10);
  });

  it("works out the patient's balance due from current payments and refunds, and each insurer's outstanding", () => {
    const s = invoiceShares({
      invType: "INSURANCE",
      total: 1000,
      writeOff: 0,
      creditNote: 0,
      claims: [
        { payerId: "P1", amount: 500, remitted: 300, rejected: 50 },
        { payerId: "P1", amount: 300, remitted: 300, rejected: 0 },
      ],
      payments: [
        { paid: 150, refund: 0, isCurrent: true },
        { paid: 100, refund: 0, isCurrent: false },
        { paid: 0, refund: 20, isCurrent: true },
      ],
    });
    expect(s.insurers).toEqual([
      { payerId: "P1", share: 800, remitted: 600, rejected: 50, outstanding: 150 },
    ]);
    expect(s).toMatchObject({
      payerKind: "insurance",
      mainParty: "patient",
      insurerShare: 800,
      insurerOutstanding: 150,
      patientShare: 200,
      patientPaid: 130,
      balanceDue: 70,
      claimsPending: false,
      claimsExceed: false,
    });
  });

  it("shows an unmatched insurance invoice as pending with the payer unknown", () => {
    const s = invoiceShares({
      invType: "Insurance",
      total: 400,
      writeOff: 25,
      creditNote: null,
      claims: [],
      payments: [],
    });
    expect(s.claimsPending).toBe(true);
    expect(s.insurers).toEqual([
      { payerId: null, share: 375, remitted: 0, rejected: 0, outstanding: 375 },
    ]);
    expect(s.patientShare).toBe(0);
    expect(s.balanceDue).toBe(0);
  });

  it("puts a corporate invoice on the company and reduces it by write-offs; an overpayment is a credit", () => {
    const s = invoiceShares({
      invType: "CORPORATE",
      total: 300,
      writeOff: 0,
      creditNote: 50,
      claims: [],
      payments: [{ paid: 260, refund: 0, isCurrent: true }],
    });
    expect(s).toMatchObject({
      mainParty: "corporate",
      insurers: [],
      patientShare: 250,
      patientPaid: 260,
      balanceDue: -10,
    });
  });

  it("posts no patient share while the claims exceed the invoice (the journal waits)", () => {
    const s = invoiceShares({
      invType: "INSURANCE",
      total: 100,
      writeOff: 0,
      creditNote: 0,
      claims: [{ payerId: "P1", amount: 120, remitted: 0, rejected: 0 }],
      payments: [],
    });
    expect(s.claimsExceed).toBe(true);
    expect(s.patientShare).toBe(0);
  });

  it("sums in fils without float drift", () => {
    const s = invoiceShares({
      invType: "SELF PAY",
      total: 0.3,
      writeOff: 0,
      creditNote: 0,
      claims: [],
      payments: [
        { paid: 0.1, refund: 0, isCurrent: true },
        { paid: 0.2, refund: 0, isCurrent: true },
      ],
    });
    expect(s.balanceDue).toBe(0);
  });
});
