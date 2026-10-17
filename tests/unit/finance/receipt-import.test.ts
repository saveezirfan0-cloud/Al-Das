/**
 * Insurer receipt register import (matching v2). Synthetic data only. The kind has no name or ID-number field, only the
 * mapped columns are read, a reference that redaction would change refuses the row, a repeated reference with other
 * figures refuses the file, and errors never echo cell values.
 */
import { describe, expect, it } from "vitest";

import {
  fieldsFor,
  isReceiptImportKind,
  validateMapping,
  type ImportFormat,
} from "@/lib/finance/import-kinds";
import { MAX_IMPORT_ROWS, parseReceiptRegister } from "@/lib/finance/parse-import";
import { parseCsv } from "@/lib/finance/parse-remittance";

const FORMAT: ImportFormat = {
  kind: "receipt_register",
  mapping: {
    payment_ref: "Payment Ref",
    amount: "Received",
    receipt_date: "Bank Date",
    payer: "Insurer",
    receipt_no: "Receipt",
    bank_name: "Bank",
  },
  dateFormat: "DD/MM/YYYY",
  amountStyle: "signed",
};

const HEAD = "Payment Ref,Patient Name,Received,Bank Date,Insurer,Receipt,Bank,Member ID";
const table = (...rows: string[]) => parseCsv([HEAD, ...rows].join("\n"));

describe("receipt register kind", () => {
  it("has the six fields, three required, and no name or ID field", () => {
    expect(isReceiptImportKind("receipt_register")).toBe(true);
    expect(isReceiptImportKind("settlement")).toBe(false);
    expect(fieldsFor("receipt_register", "signed").map((f) => [f.key, f.required])).toEqual([
      ["payment_ref", true],
      ["amount", true],
      ["receipt_date", true],
      ["payer", false],
      ["receipt_no", false],
      ["bank_name", false],
    ]);
    const m = validateMapping("receipt_register", "signed", {
      payment_ref: "Ref",
      amount: "Amt",
      receipt_date: "Date",
      patient_name: "Patient Name",
    });
    expect(m).toEqual({
      ok: true,
      mapping: { payment_ref: "Ref", amount: "Amt", receipt_date: "Date" },
    });
  });
});

describe("parseReceiptRegister", () => {
  it("reads only mapped columns, normalises text, and ignores the patient columns", () => {
    const r = parseReceiptRegister(
      table(
        'PAY-0001,Layla Demo-07,"1,250.50",05/10/2026,  syn insurer ,RC-77,Synthetic Bank,SYN-MEMBER-1',
        "PAY-0002,Omar Demo-08,300,06/10/2026,,,,",
        ",,,,,,,",
      ),
      FORMAT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([
      {
        payment_ref: "PAY-0001",
        amount: 1250.5,
        receipt_date: "2026-10-05",
        payer: "SYN INSURER",
        receipt_no: "RC-77",
        bank_name: "Synthetic Bank",
      },
      {
        payment_ref: "PAY-0002",
        amount: 300,
        receipt_date: "2026-10-06",
        payer: null,
        receipt_no: null,
        bank_name: null,
      },
    ]);
    expect(r.stats.skipped).toBe(1);
    expect(JSON.stringify(r.rows)).not.toMatch(/Demo|SYN-MEMBER/);
  });

  it("truncates to the database limits", () => {
    const r = parseReceiptRegister(
      table(
        `R${"A".repeat(100)},x,10,01/10/2026,${"i".repeat(90)},${"n".repeat(90)},${"b".repeat(90)},`,
      ),
      FORMAT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].payment_ref).toHaveLength(80);
    expect(r.rows[0].payer).toHaveLength(60);
    expect(r.rows[0].receipt_no).toHaveLength(60);
    expect(r.rows[0].bank_name).toHaveLength(60);
  });

  it("refuses a card-number-looking reference without echoing it", () => {
    const r = parseReceiptRegister(table("4111111111111111,x,10,01/10/2026,,,,"), FORMAT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toContain(
      "Row 2: payment reference looks like a card or account number",
    );
    expect(r.errors.join(" ")).not.toContain("4111");
  });

  it("drops a formula prefix and keeps the reference usable", () => {
    const r = parseReceiptRegister(
      table("=PAY9,x,10,01/10/2026,,,,", "@PAY8,x,10,01/10/2026,,,,"),
      FORMAT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows.map((x) => x.payment_ref)).toEqual(["PAY9", "PAY8"]);
  });

  it("skips zero and negative amounts and total lines, counting them", () => {
    const r = parseReceiptRegister(
      table("A1,x,0,01/10/2026,,,,", "A2,x,-5,01/10/2026,,,,", "A3,x,5,01/10/2026,,,,"),
      FORMAT,
    );
    expect(r.ok && r.stats).toMatchObject({ rows: 1, skipped: 2 });
  });

  it("reads Excel-style dates in the layout's format", () => {
    const us = { ...FORMAT, dateFormat: "MM/DD/YYYY" as const };
    const r = parseReceiptRegister(table("A1,x,5,10/05/2026,,,,", "A2,x,5,31.10.2026,,,,"), FORMAT);
    expect(r.ok && r.rows.map((x) => x.receipt_date)).toEqual(["2026-05-10", "2026-10-31"]);
    const u = parseReceiptRegister(table("A1,x,5,10/05/2026,,,,"), us);
    expect(u.ok && u.rows[0].receipt_date).toBe("2026-10-05");
  });

  it("collapses a repeated reference with the same figures", () => {
    const r = parseReceiptRegister(
      table("PAY-1,x,10,01/10/2026,,,,", "pay1,x,10.00,01/10/2026,,,,"),
      FORMAT,
    );
    expect(r.ok && r.rows).toHaveLength(1);
    expect(r.ok && r.stats.skipped).toBe(1);
  });

  it("refuses a repeated reference with other figures, naming the rows only", () => {
    const r = parseReceiptRegister(
      table("PAY-1,x,10,01/10/2026,,,,", "PAY-1,x,11,01/10/2026,,,,"),
      FORMAT,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toBe(
      "Rows 2 and 3: the same payment reference with a different amount or date.",
    );
  });

  it("refuses bad rows with row numbers and field names, never values", () => {
    const r = parseReceiptRegister(
      table(
        ",x,10,01/10/2026,,,,",
        "SECRET1,x,abc,01/10/2026,,,,",
        "SECRET2,x,10,32/13/2026,,,,",
        "SECRET3,x,10,,,,,",
      ),
      FORMAT,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = r.errors.join("\n");
    expect(text).toContain("Row 2");
    expect(text).toContain("Row 3");
    expect(text).toContain("Row 4");
    expect(text).toContain("Row 5");
    expect(text).not.toMatch(/SECRET|abc/);
  });

  it("refuses a file missing a mapped column, and a wrong kind", () => {
    const r = parseReceiptRegister(parseCsv("Payment Ref,Received\nA1,5"), FORMAT);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.length).toBeGreaterThan(0);
    const w = parseReceiptRegister(table("A1,x,5,01/10/2026,,,,"), {
      ...FORMAT,
      kind: "settlement",
    });
    expect(w.ok).toBe(false);
  });

  it("refuses a file with no data rows and one over the row limit", () => {
    expect(parseReceiptRegister(table(), FORMAT).ok).toBe(false);
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [
      `R${i}`,
      "x",
      "1",
      "01/10/2026",
      "",
      "",
      "",
      "",
    ]);
    const big = parseReceiptRegister([HEAD.split(","), ...rows], FORMAT);
    expect(big.ok).toBe(false);
  });
});
