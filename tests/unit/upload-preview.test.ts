/**
 * Phase G: the one upload component's rules (pure). The browser checks type and size before sending; the server's
 * preview shows the mapped columns of the first rows only, lists the other columns by NAME (their values never appear),
 * and names the mapped columns a file is missing. Synthetic tables only.
 */
import { describe, expect, it } from "vitest";

import { previewImportTable } from "@/lib/finance/import-preview";
import { MAX_IMPORT_BYTES } from "@/lib/finance/parse-import";
import {
  buildUploadPreview,
  FINANCE_IMPORT_LIMITS,
  fileProblem,
  formatSize,
} from "@/lib/upload/preview";

describe("fileProblem", () => {
  const limits = { extensions: [".csv", ".xlsx"], maxBytes: 5 * 1024 * 1024 };
  it("accepts the allowed types up to the limit, whatever the case of the extension", () => {
    expect(fileProblem({ name: "statement.CSV", size: 1200 }, limits)).toBeNull();
    expect(fileProblem({ name: "a.b.xlsx", size: limits.maxBytes }, limits)).toBeNull();
  });
  it("refuses other types, empty and oversized files, saying what is allowed", () => {
    expect(fileProblem({ name: "statement.pdf", size: 10 }, limits)).toBe(
      "Choose a .csv or .xlsx file.",
    );
    expect(fileProblem({ name: "noextension", size: 10 }, limits)).toMatch(/\.csv or \.xlsx/);
    expect(fileProblem({ name: "x.csv", size: 0 }, limits)).toBe("That file is empty.");
    expect(fileProblem({ name: "x.csv", size: limits.maxBytes + 1 }, limits)).toBe(
      "That file is 5 MB; the limit is 5 MB.",
    );
    expect(fileProblem({ name: "x.xlsx", size: 7.5 * 1024 * 1024 }, limits)).toMatch(/7\.5 MB/);
  });
  it("matches the import engine's own size limit", () => {
    expect(FINANCE_IMPORT_LIMITS.maxBytes).toBe(MAX_IMPORT_BYTES);
    expect(FINANCE_IMPORT_LIMITS.extensions).toEqual([".csv", ".xlsx"]);
    expect(formatSize(512)).toBe("512 bytes");
    expect(formatSize(2048)).toBe("2 KB");
  });
});

describe("buildUploadPreview", () => {
  const SECRET = "Layla Demo-07"; // stands in for a name in a column the layout does not map
  const table = [
    ["Account statement", "", ""],
    ["Period 1 to 30 September", "", ""],
    [],
    ["Value Date", " Customer  Name ", "Amount", "Description", "Notes"],
    ["01/09/2026", SECRET, "1,200.00", "POS 4111 1111 1111 1111", "x"],
    ["", "", "", "", ""],
    ["02/09/2026", SECRET, "-50", "Fee", ""],
    ["03/09/2026", SECRET, "75", "Transfer", ""],
  ];
  const wanted = [
    { field: "value_date", label: "Value date", header: "value date" },
    { field: "amount", label: "Amount (signed)", header: "Amount" },
    { field: "description", label: "Description", header: "DESCRIPTION" },
  ];

  it("finds the header below a preamble and previews the mapped columns of the first rows", () => {
    const p = buildUploadPreview(table, wanted, { maxRows: 2 });
    expect(p.headerRow).toBe(4);
    expect(p.columns.map((c) => c.field)).toEqual(["value_date", "amount", "description"]);
    expect(p.rows).toEqual([
      ["01/09/2026", "1,200.00", "POS 4111 1111 1111 1111"],
      ["02/09/2026", "-50", "Fee"],
    ]);
    expect(p.dataRows).toBe(3); // the blank row is not counted
    expect(p.missing).toEqual([]);
  });

  it("lists unmapped columns by name only and never shows their values", () => {
    const p = buildUploadPreview(table, wanted);
    expect(p.unknown).toEqual(["Customer Name", "Notes"]);
    expect(p.unknownMore).toBe(0);
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });

  it("names the mapped columns a file is missing", () => {
    const p = buildUploadPreview(table, [
      ...wanted,
      { field: "reference", label: "Reference", header: "Bank ref" },
    ]);
    expect(p.missing).toEqual(["Bank ref (Reference)"]);
    expect(p.headerRow).toBe(4);
    const none = buildUploadPreview([["a", "b"], ["1", "2"]], wanted);
    expect(none).toMatchObject({ headerRow: null, rows: [], unknown: [], dataRows: 0 });
    expect(none.missing).toHaveLength(3);
  });

  it("caps long lists and long names", () => {
    const header = ["Value Date", ...Array.from({ length: 40 }, (_, i) => `Extra ${i}`), "x".repeat(90)];
    const p = buildUploadPreview([header, ["01/09/2026"]], [wanted[0]]);
    expect(p.unknown).toHaveLength(30);
    expect(p.unknownMore).toBe(11);
    expect(Math.max(...p.unknown.map((u) => u.length))).toBeLessThanOrEqual(60);
  });
});

describe("previewImportTable (finance imports)", () => {
  it("redacts statement text as it would be stored and shows only the layout's columns", () => {
    const p = previewImportTable(
      [
        ["Date", "Amt", "Narrative", "Holder"],
        ["01/09/2026", "100", "CARD 4111111111111111 PAYMENT", "Layla Demo-07"],
      ],
      {
        kind: "bank_statement",
        mapping: { value_date: "Date", amount: "Amt", description: "Narrative" },
        dateFormat: "DD/MM/YYYY",
        amountStyle: "signed",
      },
    );
    expect(p.unknown).toEqual(["Holder"]);
    expect(p.rows[0][0]).toBe("01/09/2026");
    expect(p.rows[0][2]).not.toContain("4111111111111111");
    expect(JSON.stringify(p)).not.toContain("Layla");
  });

  it("masks a Unite PIN on a lab file and never reads the name column", () => {
    const p = previewImportTable(
      [
        ["Sample date", "Test", "PIN", "Patient name", "Emirates ID"],
        ["2026-09-01", "85025", "PIN-000123", "Layla Demo-07", "784-0000-0000000-0"],
      ],
      {
        kind: "lab_activity",
        mapping: { service_date: "Sample date", test_code: "Test", patient_pin: "PIN" },
        dateFormat: "YYYY-MM-DD",
        amountStyle: "signed",
      },
    );
    expect(p.rows).toEqual([["2026-09-01", "85025", "•••123"]]);
    expect(p.unknown).toEqual(["Patient name", "Emirates ID"]);
    expect(JSON.stringify(p)).not.toMatch(/Layla|784-0000/);
  });
});
