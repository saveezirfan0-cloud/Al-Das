import { describe, expect, it } from "vitest";

import { voucherCertificatePdf, type VoucherCertificate } from "@/lib/finance/voucher-certificate";
import {
  financeDocumentPath,
  isFinanceDocumentPathFor,
  parseFinanceDocumentPath,
} from "@/lib/media/paths";
import { validateMedia } from "@/lib/media/limits";

// Synthetic voucher; no real people.
const cert = (events = 6): VoucherCertificate => ({
  org: "Clinic Test",
  voucherNo: "PV-2026-0003",
  voucherDate: "2026-10-05",
  payeeName: "Supplier Test 01",
  supplierName: "Supplier Test 01",
  amount: 22000,
  currency: "AED",
  category: "Insurance premium",
  special: "none",
  branchCode: "P",
  costCentre: null,
  payFrom: "BANK-MAIN",
  paymentMethod: "bank_transfer",
  narration: "Annual premium, October — test",
  status: "approved",
  route: "pulse",
  tier: "T3",
  needsDept: false,
  needsCeo: true,
  contentHash: "a".repeat(64),
  currentHash: "a".repeat(64),
  invoices: [{ number: "INV-TEST-1", date: "2026-10-01", total: 22000 }],
  documents: [{ kind: "supplier_invoice", sha256: "b".repeat(64), sizeBytes: 245_000 }],
  events: Array.from({ length: events }, (_, i) => ({
    at: new Date(Date.UTC(2026, 9, 5, 8 + i)).toISOString(),
    action: ["created", "submitted", "checked", "rejected", "submitted", "ceo_approved"][i % 6],
    actor: [
      "Maker Test",
      "Maker Test",
      "Checker Test",
      "Approver Test",
      "Maker Test",
      "Approver Test",
    ][i % 6],
    fromStatus: "draft",
    toStatus: "submitted",
    remarks: i % 6 === 3 ? "Quotation missing" : null,
    hash: "a".repeat(64),
  })),
  payment: null,
  timezone: "Asia/Dubai",
});

describe("approval certificate PDF", () => {
  it("renders a PDF from the stored voucher and its trail, the same bytes every time", async () => {
    const a = await voucherCertificatePdf(cert());
    const b = await voucherCertificatePdf(cert());
    expect(a.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("paginates a long trail", async () => {
    const short = await voucherCertificatePdf(cert(6));
    const long = await voucherCertificatePdf(cert(120));
    const { PDFDocument } = await import("pdf-lib");
    const pages = async (pdf: Buffer) => (await PDFDocument.load(pdf)).getPageCount();
    expect(await pages(short)).toBeGreaterThanOrEqual(1);
    expect(await pages(long)).toBeGreaterThan(await pages(short));
  });
});

describe("finance document storage paths and limits", () => {
  const org = "11111111-2222-4333-8444-555555555555";
  const doc = "66666666-7777-4888-8999-000000000000";

  it("builds <org>/<document>.<ext> and parses only that shape", () => {
    const p = financeDocumentPath(org, doc, "pdf");
    expect(p).toBe(`${org}/${doc}.pdf`);
    expect(parseFinanceDocumentPath(p)).toEqual({ orgId: org, documentId: doc, extension: "pdf" });
    expect(isFinanceDocumentPathFor(p, org, doc)).toBe(true);
    expect(isFinanceDocumentPathFor(p, doc, doc)).toBe(false);
    for (const bad of [
      `${org}/../${doc}.pdf`,
      `${org}/${doc}`,
      `${org}/x/${doc}.pdf`,
      `${org}/invoice.pdf`,
      `${org}/${doc}.p df`,
    ])
      expect(parseFinanceDocumentPath(bad), bad).toBeNull();
    expect(() => financeDocumentPath(org, "not-a-uuid", "pdf")).toThrow();
  });

  it("accepts PDFs, phone photos and Excel up to 20 MB, nothing else", () => {
    expect(
      validateMedia({ mime: "application/pdf", size: 1000 }, "finance_document"),
    ).toMatchObject({ ok: true, extension: "pdf" });
    expect(validateMedia({ mime: "image/heic", size: 1000 }, "finance_document")).toMatchObject({
      ok: true,
    });
    expect(
      validateMedia(
        { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size: 1000 },
        "finance_document",
      ),
    ).toMatchObject({ ok: true, extension: "xlsx" });
    expect(validateMedia({ mime: "application/zip", size: 1000 }, "finance_document").ok).toBe(
      false,
    );
    expect(
      validateMedia({ mime: "application/pdf", size: 21 * 1024 * 1024 }, "finance_document").ok,
    ).toBe(false);
    expect(validateMedia({ mime: "application/pdf", size: 0 }, "finance_document").ok).toBe(false);
  });
});
