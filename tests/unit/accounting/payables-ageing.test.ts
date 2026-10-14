/**
 * Phase G: payables ageing and the supplier statement (pure). Synthetic suppliers, invoices and vouchers only.
 */
import { describe, expect, it } from "vitest";

import {
  buildPayablesAgeing,
  buildSupplierStatement,
  payableDueDate,
  settledOn,
  type PayableInvoice,
  type SupplierPayment,
} from "@/lib/accounting/payables-ageing";
import { payablesAgeingWorkbook, supplierStatementWorkbook } from "@/lib/accounting/payables-xlsx";

const SUPPLIERS = [
  { id: "s-lab", name: "Synthetic Lab Co", termsDays: 30 },
  { id: "s-med", name: "Demo Medical Supplies", termsDays: null },
];

const inv = (over: Partial<PayableInvoice>): PayableInvoice => ({
  id: "i",
  supplierId: "s-lab",
  number: "SYN-1",
  invoiceDate: "2026-08-01",
  dueDate: null,
  total: 100,
  currency: "AED",
  status: "open",
  ...over,
});
const pay = (over: Partial<SupplierPayment>): SupplierPayment => ({
  id: "v",
  supplierId: "s-lab",
  voucherNo: "PV-2026-0001",
  date: "2026-09-10",
  amount: 100,
  currency: "AED",
  invoiceIds: [],
  ...over,
});

const INVOICES = [
  inv({ id: "i1", number: "SYN-1", invoiceDate: "2026-06-01", total: 1000 }), // due 07-01 by terms: 91 days at 09-30
  inv({
    id: "i2",
    number: "SYN-2",
    invoiceDate: "2026-09-15",
    dueDate: "2026-10-15",
    total: "250.50",
  }), // current
  inv({ id: "i3", number: "SYN-3", invoiceDate: "2026-08-01", total: 400, status: "paid" }), // paid 09-10
  inv({ id: "i4", number: "SYN-4", invoiceDate: "2026-08-20", total: 300, status: "paid" }), // paid 10-05 (after)
  inv({ id: "i5", number: "SYN-5", invoiceDate: "2026-08-25", total: 999, status: "void" }),
  inv({ id: "i6", number: "SYN-6", invoiceDate: "2026-10-02", total: 50 }), // after the date
  inv({ id: "i7", supplierId: "s-med", number: "MED-1", invoiceDate: "2026-09-01", total: 75 }), // no terms: due 09-01
  inv({
    id: "i8",
    supplierId: "s-med",
    number: "MED-USD",
    invoiceDate: "2026-09-01",
    total: 10,
    currency: "USD",
  }),
];
const PAYMENTS = [
  pay({ id: "v1", voucherNo: "PV-2026-0001", date: "2026-09-10", amount: 400, invoiceIds: ["i3"] }),
  pay({ id: "v2", voucherNo: "PV-2026-0002", date: "2026-10-05", amount: 300, invoiceIds: ["i4"] }),
  pay({
    id: "v3",
    voucherNo: "PV-2026-0003",
    supplierId: "s-med",
    date: "2026-09-20",
    amount: 20,
    invoiceIds: [],
  }),
];

describe("payables ageing", () => {
  it("works out due dates from the invoice, the supplier's terms or the invoice date", () => {
    expect(payableDueDate({ invoiceDate: "2026-06-01", dueDate: null }, 30)).toBe("2026-07-01");
    expect(payableDueDate({ invoiceDate: "2026-06-01", dueDate: "2026-06-15" }, 30)).toBe(
      "2026-06-15",
    );
    expect(payableDueDate({ invoiceDate: "2026-06-01", dueDate: null }, null)).toBe("2026-06-01");
    expect(settledOn(PAYMENTS).get("i4")).toBe("2026-10-05");
  });

  it("ages what was open at the date: paid-later invoices count, void and later ones do not", () => {
    const a = buildPayablesAgeing(INVOICES, PAYMENTS, SUPPLIERS, "2026-09-30");
    expect(a.rows.map((r) => r.name)).toEqual(["Demo Medical Supplies", "Synthetic Lab Co"]);
    const lab = a.rows.find((r) => r.supplierId === "s-lab")!;
    expect(lab.buckets).toEqual({
      current: 250.5,
      d1_30: 300, // SYN-4 due 09-19 by terms, paid only on 10-05
      d31_60: 0,
      d61_90: 0,
      d91_120: 1000,
      d120_plus: 0,
    });
    expect(lab.openInvoices).toBe(3);
    expect(lab.total).toBe(1550.5);
    const med = a.rows.find((r) => r.supplierId === "s-med")!;
    expect(med.buckets.d1_30).toBe(75);
    expect(med.onAccount).toBe(-20);
    expect(med.total).toBe(55);
    expect(a.totals.total).toBe(1605.5);
    expect(a.totals.openInvoices).toBe(4);
    expect(a.otherCurrency).toBe(1);
    expect(a.open[0]).toMatchObject({ number: "SYN-1", daysOverdue: 91, bucket: "d91_120" });
  });

  it("drops an invoice once its voucher is paid, and keeps one marked paid without a known date out", () => {
    const later = buildPayablesAgeing(INVOICES, PAYMENTS, SUPPLIERS, "2026-10-31");
    expect(later.open.map((o) => o.number)).not.toContain("SYN-4");
    expect(later.open.map((o) => o.number)).toContain("SYN-6");
    const odd = buildPayablesAgeing(
      [inv({ id: "x", status: "paid" })],
      [],
      SUPPLIERS,
      "2026-09-30",
    );
    expect(odd.rows).toEqual([]);
  });
});

describe("supplier statement", () => {
  it("runs the balance owed from the opening through invoices and payments", () => {
    const lab = INVOICES.filter((i) => i.supplierId === "s-lab");
    const labPay = PAYMENTS.filter((p) => p.supplierId === "s-lab");
    const s = buildSupplierStatement(lab, labPay, "2026-08-01", "2026-09-30");
    expect(s.opening).toBe(1000);
    expect(s.rows.map((r) => [r.date, r.kind, r.number, r.credit, r.debit, r.balance])).toEqual([
      ["2026-08-01", "invoice", "SYN-3", 400, 0, 1400],
      ["2026-08-20", "invoice", "SYN-4", 300, 0, 1700],
      ["2026-09-10", "payment", "PV-2026-0001", 0, 400, 1300],
      ["2026-09-15", "invoice", "SYN-2", 250.5, 0, 1550.5],
    ]);
    expect(s).toMatchObject({ billed: 950.5, paid: 400, closing: 1550.5, otherCurrency: 0 });
  });

  it("shows an advance as a negative balance", () => {
    const s = buildSupplierStatement([], [pay({ amount: 20 })], "2026-09-01", "2026-09-30");
    expect(s.closing).toBe(-20);
  });
});

describe("payables workbooks", () => {
  it("build without formulas and with every open invoice", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const a = buildPayablesAgeing(INVOICES, PAYMENTS, SUPPLIERS, "2026-09-30");
    const buf = await payablesAgeingWorkbook(a, {
      org: "Synthetic Clinic",
      builtAt: "2026-10-14T08:00:00.000Z",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["By supplier", "Open invoices"]);
    const open = wb.getWorksheet("Open invoices")!;
    const values = open
      .getSheetValues()
      .flat()
      .filter((v) => typeof v === "string");
    expect(values).toEqual(expect.arrayContaining(["SYN-1", "SYN-2", "SYN-4", "MED-1"]));
    const s = buildSupplierStatement(
      INVOICES.filter((i) => i.supplierId === "s-lab"),
      [],
      "2026-08-01",
      "2026-09-30",
    );
    const sb = await supplierStatementWorkbook(
      { ...s, supplier: { name: '=HYPERLINK("x")' } },
      { org: "Synthetic Clinic", builtAt: "2026-10-14T08:00:00.000Z" },
    );
    const w2 = new ExcelJS.Workbook();
    await w2.xlsx.load(sb as unknown as ArrayBuffer);
    const cells: unknown[] = [];
    w2.worksheets[0].eachRow((r) => r.eachCell((c) => cells.push(c.value)));
    expect(cells.some((v) => typeof v === "object" && v !== null && "formula" in v)).toBe(false);
  });
});
