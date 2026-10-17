import { describe, expect, it } from "vitest";

import {
  claimState,
  rowFromShares,
  summarizeBilling,
  type BillingRow,
} from "@/lib/contacts/patient-billing";
import { invoiceShares } from "@/lib/finance/invoice-shares";

const base = (id: string) => ({
  id,
  number: id,
  date: "2026-09-01",
  void: false,
  net: 100,
  paid: null as number | null,
  claimed: null as number | null,
});

describe("claimState", () => {
  it("has no insurer on a self-pay invoice, and 'not claimed' before any claim matches", () => {
    expect(claimState(false, [])).toBe("not_applicable");
    expect(claimState(true, [])).toBe("not_claimed");
  });

  it("reads the claims' own amounts", () => {
    expect(claimState(true, [{ net: 100, remitted: 0, rejected: 0 }])).toBe("awaiting");
    expect(claimState(true, [{ net: 100, remitted: 40, rejected: 0 }])).toBe("partly_paid");
    expect(claimState(true, [{ net: 100, remitted: 100, rejected: 0 }])).toBe("paid");
    expect(claimState(true, [{ net: 100, remitted: 0, rejected: 100 }])).toBe("rejected");
    expect(claimState(true, [{ net: "100.00", remitted: "60.00", rejected: "40.00" }])).toBe(
      "rejected",
    );
    expect(claimState(true, [{ net: 100, remitted: 0, rejected: 30 }])).toBe("partly_paid");
  });

  it("adds several claims on one invoice together", () => {
    expect(
      claimState(true, [
        { net: 50, remitted: 50, rejected: 0 },
        { net: 50, remitted: 0, rejected: 0 },
      ]),
    ).toBe("partly_paid");
    expect(
      claimState(true, [
        { net: 50, remitted: 50, rejected: 0 },
        { net: 50, remitted: 50, rejected: 0 },
      ]),
    ).toBe("paid");
  });
});

describe("billing summary", () => {
  const selfPay = rowFromShares(
    { ...base("A"), paid: 30 },
    invoiceShares({
      invType: "SELF PAY",
      total: 100,
      writeOff: 0,
      creditNote: 0,
      claims: [],
      payments: [{ paid: 30, refund: 0, isCurrent: true }],
    }),
    [],
  );
  const insured = rowFromShares(
    base("B"),
    invoiceShares({
      invType: "INSURANCE",
      total: 100,
      writeOff: 0,
      creditNote: 0,
      claims: [{ payerId: "P1", amount: 80, remitted: 20, rejected: 0 }],
      payments: [],
    }),
    [{ net: 80, remitted: 20, rejected: 0 }],
  );

  it("works out who owes what with the invoice view's own rule", () => {
    expect(selfPay.balanceDue).toBe(70);
    expect(selfPay.claimState).toBe("not_applicable");
    // 20 copay left to the patient, 60 still owed by the insurer
    expect(insured.balanceDue).toBe(20);
    expect(insured.insurerOutstanding).toBe(60);
    expect(insured.claimState).toBe("partly_paid");
  });

  it("totals the open balance, the insurers' share and the claim states", () => {
    const s = summarizeBilling([selfPay, insured]);
    expect(s.patientDue).toBe(90);
    expect(s.insurerOutstanding).toBe(60);
    expect(s.openInvoices).toBe(2);
    expect(s.counted).toBe(2);
    expect(s.claims).toEqual({ partly_paid: 1 });
  });

  it("leaves out void invoices, counts credits apart and skips what could not be worked out", () => {
    const credit = rowFromShares(
      { ...base("C"), paid: 150 },
      invoiceShares({
        invType: "SELF PAY",
        total: 100,
        writeOff: 0,
        creditNote: 0,
        claims: [],
        payments: [{ paid: 150, refund: 0, isCurrent: true }],
      }),
      [],
    );
    const voided: BillingRow = { ...selfPay, id: "V", void: true };
    const unknown = rowFromShares(base("U"), null, null);
    const s = summarizeBilling([selfPay, credit, voided, unknown]);
    expect(s.patientDue).toBe(70);
    expect(s.patientCredit).toBe(50);
    expect(s.skipped).toBe(1);
    expect(s.counted).toBe(2);
    expect(s.openInvoices).toBe(1);
  });

  it("has nothing for a patient without invoices", () => {
    expect(summarizeBilling([])).toEqual({
      patientDue: 0,
      patientCredit: 0,
      insurerOutstanding: 0,
      openInvoices: 0,
      counted: 0,
      skipped: 0,
      claims: {},
    });
  });
});
