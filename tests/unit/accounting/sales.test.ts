import { describe, expect, it } from "vitest";

import {
  ageBucket,
  allocateOldestFirst,
  buildAgeing,
  creditNoteLate,
  dueDateFor,
  invoiceForm,
  invoiceTotals,
  lineAmounts,
  lineProblem,
  needsApproval,
  statementWithBalance,
} from "@/lib/accounting/sales";

/** Phase 22E pure rules (synthetic amounts only). */

describe("line amounts and VAT", () => {
  it("works out gross, discount, net, VAT (per line, 2 dp) and total", () => {
    expect(lineAmounts({ quantity: 3, unitPrice: 100, discount: 10, vatRate: 5 })).toEqual({
      gross: 300,
      discount: 10,
      net: 290,
      vat: 14.5,
      total: 304.5,
    });
  });

  it("rounds VAT half away from zero to the fil", () => {
    // 0.10 x 5% = 0.005 -> 0.01; 0.30 x 5% = 0.015 -> 0.02
    expect(lineAmounts({ quantity: 1, unitPrice: 0.1, discount: 0, vatRate: 5 }).vat).toBe(0.01);
    expect(lineAmounts({ quantity: 1, unitPrice: 0.3, discount: 0, vatRate: 5 }).vat).toBe(0.02);
    expect(lineAmounts({ quantity: 1, unitPrice: 1.01, discount: 0, vatRate: 5 }).vat).toBe(0.05);
  });

  it("rounds the gross of a fractional quantity to the fil", () => {
    // 1.005 x 10.01 = 10.06005 -> 10.06; 2.5 x 0.03 = 0.075 -> 0.08
    expect(lineAmounts({ quantity: 1.005, unitPrice: 10.01, discount: 0, vatRate: 0 }).gross).toBe(10.06);
    expect(lineAmounts({ quantity: 2.5, unitPrice: 0.03, discount: 0, vatRate: 0 }).gross).toBe(0.08);
  });

  it("sums per-line VAT, which can differ from VAT on the invoice total (the documented choice)", () => {
    const lines = Array.from({ length: 3 }, () => ({
      quantity: 1,
      unitPrice: 0.1,
      discount: 0,
      vatRate: 5,
    }));
    const t = invoiceTotals(lines);
    expect(t.net).toBe(0.3);
    expect(t.vat).toBe(0.03); // 3 x 0.01, not round(0.30 x 5%) = 0.02
    expect(t.total).toBe(0.33);
  });

  it("totals zero-rated and standard lines with a VAT summary per rate", () => {
    const t = invoiceTotals([
      { quantity: 2, unitPrice: 250, discount: 0, vatRate: 0 },
      { quantity: 1, unitPrice: 1000, discount: 100, vatRate: 5 },
      { quantity: 1, unitPrice: 19.99, discount: 0, vatRate: 5 },
    ]);
    expect(t).toEqual({
      subtotal: 1519.99,
      discount: 100,
      net: 1419.99,
      vat: 46,
      total: 1465.99,
      byRate: [
        { rate: 5, net: 919.99, vat: 46 },
        { rate: 0, net: 500, vat: 0 },
      ],
    });
  });

  it("flags impossible lines", () => {
    expect(lineProblem({ quantity: 0, unitPrice: 1, discount: 0, vatRate: 5 })).toBe("quantity");
    expect(lineProblem({ quantity: 1.0001, unitPrice: 1, discount: 0, vatRate: 5 })).toBe(
      "quantity",
    );
    expect(lineProblem({ quantity: 1, unitPrice: 1.001, discount: 0, vatRate: 5 })).toBe(
      "unit_price",
    );
    expect(lineProblem({ quantity: 1, unitPrice: 10, discount: 10.01, vatRate: 5 })).toBe(
      "discount_above_gross",
    );
    expect(lineProblem({ quantity: 1, unitPrice: 10, discount: -1, vatRate: 5 })).toBe("discount");
    expect(lineProblem({ quantity: 2, unitPrice: 10, discount: 20, vatRate: 5 })).toBeNull();
  });
});

describe("full or simplified tax invoice", () => {
  it("is simplified only for an unregistered customer at AED 10,000 or less", () => {
    expect(invoiceForm(null, 9_999.99)).toBe("simplified");
    expect(invoiceForm("", 10_000)).toBe("simplified");
    expect(invoiceForm(null, 10_000.01)).toBe("full");
    expect(invoiceForm("100000000000003", 50)).toBe("full");
  });
  it("honours a lower limit from the settings", () => {
    expect(invoiceForm(null, 600, 500)).toBe("full");
  });
});

describe("dates", () => {
  it("adds the credit terms to the invoice date", () => {
    expect(dueDateFor("2026-07-15", 30)).toBe("2026-08-14");
    expect(dueDateFor("2026-12-31", 1)).toBe("2027-01-01");
    expect(dueDateFor("2028-02-28", 1)).toBe("2028-02-29");
  });
  it("warns when a credit note comes more than 14 days after its event", () => {
    expect(creditNoteLate("2026-07-01", "2026-07-15")).toBe(false);
    expect(creditNoteLate("2026-07-01", "2026-07-16")).toBe(true);
    expect(creditNoteLate(null, "2026-07-16")).toBe(false);
  });
});

describe("allocation oldest first", () => {
  const invoices = [
    { id: "b", invoiceDate: "2026-08-01", number: "SI/2026-27/00002", open: 300 },
    { id: "a", invoiceDate: "2026-07-01", number: "SI/2026-27/00001", open: 200 },
    { id: "c", invoiceDate: "2026-08-01", number: "SI/2026-27/00003", open: 100 },
    { id: "z", invoiceDate: "2026-06-01", number: "SI/2025-26/00009", open: 0 },
  ];
  it("pays the oldest invoice first, then by number", () => {
    expect(allocateOldestFirst(450, invoices)).toEqual({
      allocations: [
        { invoiceId: "a", amount: 200 },
        { invoiceId: "b", amount: 250 },
      ],
      unallocated: 0,
    });
  });
  it("leaves the rest on account", () => {
    const r = allocateOldestFirst(700.5, invoices);
    expect(r.allocations.map((a) => a.amount)).toEqual([200, 300, 100]);
    expect(r.unallocated).toBe(100.5);
  });
});

describe("ageing", () => {
  it("buckets by days past due", () => {
    const asOf = "2026-12-31";
    expect(ageBucket(asOf, "2026-12-31")).toBe("current");
    expect(ageBucket(asOf, "2027-01-15")).toBe("current");
    expect(ageBucket(asOf, "2026-12-30")).toBe("d1_30");
    expect(ageBucket(asOf, "2026-12-01")).toBe("d1_30");
    expect(ageBucket(asOf, "2026-11-30")).toBe("d31_60");
    expect(ageBucket(asOf, "2026-10-02")).toBe("d61_90");
    expect(ageBucket(asOf, "2026-09-02")).toBe("d91_120");
    expect(ageBucket(asOf, "2026-09-01")).toBe("d120_plus");
  });
  it("sums per customer with money on account as a negative", () => {
    const a = buildAgeing(
      [
        { customerId: "x", kind: "invoice", dueDate: "2026-12-31", open: 100.1 },
        { customerId: "x", kind: "invoice", dueDate: "2026-11-01", open: 200.2 },
        { customerId: "x", kind: "on_account", dueDate: null, open: 50 },
        { customerId: "y", kind: "invoice", dueDate: "2026-01-01", open: 0.3 },
      ],
      "2026-12-31",
    );
    expect(a.rows.find((r) => r.customerId === "x")).toEqual({
      customerId: "x",
      buckets: { current: 100.1, d1_30: 0, d31_60: 200.2, d61_90: 0, d91_120: 0, d120_plus: 0 },
      onAccount: -50,
      total: 250.3,
    });
    expect(a.totals.total).toBe(250.6);
    expect(a.totals.buckets.d120_plus).toBe(0.3);
  });
});

describe("statement", () => {
  it("carries a running balance from the opening balance", () => {
    const s = statementWithBalance(100, [
      { date: "2026-07-10", kind: "receipt", number: "RV/2026-27/00001", reference: null, debit: 0, credit: 60 },
      { date: "2026-07-05", kind: "invoice", number: "SI/2026-27/00001", reference: "PO-1", debit: 210, credit: 0 },
      { date: "2026-07-20", kind: "credit_note", number: "CN/2026-27/00001", reference: null, debit: 0, credit: 10.5 },
    ]);
    expect(s.rows.map((r) => r.balance)).toEqual([310, 250, 239.5]);
    expect(s).toMatchObject({ opening: 100, closing: 239.5, debits: 210, credits: 70.5 });
  });
});

describe("approval limit", () => {
  it("needs a second person only above the limit", () => {
    expect(needsApproval(50_000, 50_000)).toBe(false);
    expect(needsApproval(50_000.01, 50_000)).toBe(true);
  });
});
