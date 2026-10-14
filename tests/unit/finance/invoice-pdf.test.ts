/**
 * Phase G: the internal invoice PDF ("Internal copy - not a tax invoice"). Synthetic invoice only; the patient appears as
 * a PIN, never a name.
 */
import { describe, expect, it } from "vitest";

import { internalInvoicePdf, INTERNAL_COPY } from "@/lib/finance/invoice-pdf";
import { invoiceShares } from "@/lib/finance/invoice-shares";
import type { InvoicePdfData } from "@/lib/finance/invoice-server";

const data = (over: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  number: "SYN-INV-0007",
  date: "2026-09-12",
  invType: "INSURANCE",
  branch: "G",
  department: "Dermatology",
  doctor: "Dr Demo-01",
  patientPin: "PIN-SYN-0001",
  version: 2,
  deleted: false,
  amounts: [
    ["Gross", 500],
    ["Discount", 0],
    ["Net", 500],
    ["VAT", 0],
    ["Total", 500],
    ["Write-off", 0],
    ["Credit note", 0],
  ],
  lines: Array.from({ length: 60 }, (_, i) => ({
    position: i + 1,
    code: `SVC-${i}`,
    description: "Synthetic consultation with a long description that wraps onto a second line",
    cpt: "99213",
    qty: 1,
    net: 10,
    removed: i === 3,
  })),
  payments: [{ date: "2026-09-12", mode: "CARD", receipt: "R-1", paid: 50, refund: 0 }],
  shares: invoiceShares({
    invType: "INSURANCE",
    total: 500,
    writeOff: 0,
    creditNote: 0,
    claims: [{ payerId: "PAYER-SYN-1", amount: 450, remitted: 0, rejected: 0 }],
    payments: [{ paid: 50, refund: 0, isCurrent: true }],
  }),
  payerNames: new Map([["PAYER-SYN-1", "Synthetic Insurer"]]),
  ...over,
});

describe("internal invoice PDF", () => {
  it("renders a paginated PDF marked as an internal copy", async () => {
    const pdf = await internalInvoicePdf(data(), {
      orgName: "Synthetic Clinic",
      builtAt: "2026-10-14T08:00:00.000Z",
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Invoice SYN-INV-0007 (internal copy)");
    expect(INTERNAL_COPY).toMatch(/not a tax invoice/);
  });

  it("renders without the split when the reader may not see the claims", async () => {
    const pdf = await internalInvoicePdf(data({ shares: null, lines: [], payments: [] }), {
      orgName: "",
      builtAt: "2026-10-14T08:00:00.000Z",
    });
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
