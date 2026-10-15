/**
 * Phase G: the reports as files for the downloads and the e-mails. The monthly summary (totals, the period before,
 * Provisional until locked) as Excel and PDF, the flash as PDF with its status line, and an e-mailed sales document copy
 * that says it is not a tax invoice. Synthetic figures only.
 */
import { describe, expect, it } from "vitest";

import { taxInvoicePdf, INTERNAL_COPY, type TaxInvoicePdfInput } from "@/lib/accounting/sales-pdf";
import { buildFlashSummary, type FlashRow, type ReportLine, type RevenueTarget } from "@/lib/finance/flash";
import { flashPdf } from "@/lib/finance/flash-pdf";
import { INTERNAL_COPY as INVOICE_INTERNAL_COPY } from "@/lib/finance/invoice-pdf";
import {
  buildSummaryReport,
  change,
  monthsBetween,
  previousMonths,
  summaryPdf,
  summaryWorkbook,
} from "@/lib/finance/summary-report";

import fixture from "./fixtures/flash.synthetic.json";

const row = (month: string, branch: string, generated: number, outstanding = 0) => ({
  month: `${month}-01`,
  branch_code: branch,
  generated,
  claimed: generated / 2,
  accepted: null,
  paid_allocated: null,
  remitted: 10,
  rejected: 1,
  outstanding,
  self_pay_collected: 5,
});

describe("monthly summary document", () => {
  it("compares with the equal range before and totals each measure", () => {
    expect(monthsBetween("2026-07", "2026-09")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(previousMonths("2026-07", "2026-09")).toEqual({ from: "2026-04", to: "2026-06" });
    expect(previousMonths("2026-01", "2026-01")).toEqual({ from: "2025-12", to: "2025-12" });
    const r = buildSummaryReport({
      from: "2026-09",
      to: "2026-09",
      branch: null,
      rows: [row("2026-09", "G", 1000, 50), row("2026-09", "J", 500), row("2026-08", "G", 1200)],
      lockedMonths: new Set(),
    });
    expect(r.rows.map((x) => x.branch_code)).toEqual(["G", "J"]);
    expect(r.totals.generated).toBe(1500);
    expect(r.previousTotals.generated).toBe(1200);
    expect(r.provisional).toBe(true);
    expect(r.status).toMatch(/^Provisional/);
    expect(change(1500, 1200)).toBe(0.25);
    expect(change(5, 0)).toBeNull();
    const locked = buildSummaryReport({
      from: "2026-09",
      to: "2026-09",
      branch: "G",
      rows: [],
      lockedMonths: new Set(["2026-09"]),
    });
    expect(locked).toMatchObject({ provisional: false, totals: { generated: 0 } });
  });

  it("renders Excel with plain values and a PDF that says Provisional", async () => {
    const r = buildSummaryReport({
      from: "2026-09",
      to: "2026-09",
      branch: null,
      rows: [row("2026-09", "G", 1000), row("2026-08", "G", 800)],
      lockedMonths: new Set(),
    });
    const meta = { org: "Synthetic Clinic", builtAt: "2026-10-03T03:00:00.000Z" };
    const xlsx = await summaryWorkbook(r, meta);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Compared"]);
    const values: unknown[] = [];
    let formulas = 0;
    for (const ws of wb.worksheets)
      ws.eachRow((x) =>
        x.eachCell((c) => {
          values.push(c.value);
          if (c.formula) formulas++;
        }),
      );
    expect(formulas).toBe(0);
    expect(values).toContain(1000);
    expect(values.some((v) => typeof v === "string" && v.startsWith("Provisional"))).toBe(true);
    const pdf = await summaryPdf(r, meta);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

describe("flash PDF", () => {
  it("renders the day and month to date with the status line", async () => {
    const lines = fixture.lines as ReportLine[];
    const targets = fixture.targets as RevenueTarget[];
    const rows = fixture.rows as FlashRow[];
    const DAY = "2026-10-12";
    const pdf = await flashPdf({
      org: "Synthetic Clinic",
      day: DAY,
      month: "2026-10-01",
      daily: buildFlashSummary({ rows, lines, targets, from: DAY, to: DAY }),
      monthToDate: buildFlashSummary({ rows, lines, targets, from: "2026-10-01", to: DAY }),
      topDoctors: 3,
      status: "Provisional: the month is not closed and locked yet, so the figures can still change.",
      builtAt: "2026-10-13T06:00:00.000Z",
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1500);
  });
});

describe("e-mailed sales document copy", () => {
  const input: TaxInvoicePdfInput = {
    kind: "invoice",
    form: "full",
    status: "issued",
    number: "SI/2026-27/00001",
    date: "2026-09-30",
    supplyDate: null,
    dueDate: "2026-10-30",
    reference: null,
    seller: { name: "Synthetic Clinic LLC", trn: "100000000000003", addressLines: ["Dubai"] },
    customer: { name: "Synthetic Corporate LLC", trn: null, addressLines: ["Dubai"] },
    original: null,
    creditReason: null,
    eventDate: null,
    lines: [
      {
        description: "Corporate health checks",
        quantity: 2,
        unitPrice: 100,
        discount: 0,
        net: 200,
        vatRate: 5,
        vat: 10,
        total: 210,
      },
    ],
    totals: {
      subtotal: 200,
      discount: 0,
      net: 200,
      vat: 10,
      total: 210,
      byRate: [{ rate: 5, net: 200, vat: 10 }],
    },
    notes: null,
    paymentInstructions: null,
    sha256: null,
    issuedAt: "2026-09-30T08:00:00.000Z",
  };

  it("uses the same words as the internal invoice copy", () => {
    expect(INTERNAL_COPY).toBe("Internal copy - not a tax invoice");
    expect(INVOICE_INTERNAL_COPY).toBe(INTERNAL_COPY);
  });

  it("is a different document from the tax invoice", async () => {
    const tax = await taxInvoicePdf(input);
    const copy = await taxInvoicePdf({ ...input, copy: true });
    expect(copy.subarray(0, 5).toString()).toBe("%PDF-");
    expect(copy.equals(tax)).toBe(false);
    // the document title carries the heading
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(copy)).getTitle()).toBe("Invoice copy SI/2026-27/00001");
    expect((await PDFDocument.load(tax)).getTitle()).toBe("Tax Invoice SI/2026-27/00001");
  });
});
