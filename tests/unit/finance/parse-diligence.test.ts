import { describe, expect, it } from "vitest";

import { parseDiligenceTable, readXlsxTable } from "@/lib/finance/parse-diligence";

import { BASE_ROW, row, table } from "./diligence-factory";

describe("parseDiligenceTable", () => {
  it("parses a valid file and reports sums and the date range", () => {
    const res = parseDiligenceTable(
      table([
        row(),
        row({
          ClaimActivityNumber: "CA-TEST-2",
          TransactionDate: "05-03-2026",
          NetAmt: 50,
          RemittedAmt: 50,
          RejectedAmt: 0,
        }),
      ]),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toMatchObject({
      claim_activity_number: "CA-TEST-1",
      invoice_no: "ADMC/C/90001",
      transaction_date: "2026-03-02",
      cpt_code: "99213",
      initial_net: 100,
      remitted: 60,
      rejected: 40,
      settled: false,
      claim_month: 3,
      prior_auth_id: null, // blank stays null
    });
    expect(res.stats).toMatchObject({
      rows: 2,
      minTransactionDate: "2026-03-02",
      maxTransactionDate: "2026-03-05",
      sumNet: 150,
      sumRemitted: 110,
      sumRejected: 40,
    });
  });

  it("never reads or keeps sensitive or unknown columns", () => {
    const res = parseDiligenceTable(table());
    if (!res.ok) throw new Error("expected ok");
    const json = JSON.stringify(res.rows);
    for (const secret of [
      "000-0000-0000000-0",
      "MEMBER-TEST",
      "patient said something",
      "payer note",
      "Test Patient One",
      "unknown",
    ])
      expect(json).not.toContain(secret);
    expect(res.header.droppedSensitive.sort()).toEqual(
      [
        "EmiratesIDNumber",
        "MemberID",
        "PatientName",
        "RemittanceComment",
        "ResubmissionComment",
      ].sort(),
    );
    expect(res.header.unrecognised).toEqual(["SomeUnknownColumn"]);
  });

  it("keeps blank as null, never 0", () => {
    const res = parseDiligenceTable(table([row({ UnprocessedAmt: "", WriteOffAmt: null })]));
    if (!res.ok) throw new Error("expected ok");
    expect(res.rows[0].unprocessed).toBeNull();
    expect(res.rows[0].write_off).toBeNull();
  });

  it("accepts dates as strings, JS dates and Excel serial numbers", () => {
    const res = parseDiligenceTable(
      table([
        row({
          TransactionDate: new Date(Date.UTC(2026, 2, 2)),
          ActivityStartDate: 46083,
          FirstRemittanceDate: "2026-03-20",
        }),
      ]),
    );
    if (!res.ok) throw new Error("expected ok");
    expect(res.rows[0].transaction_date).toBe("2026-03-02");
    expect(res.rows[0].activity_start_date).toBe("2026-03-02"); // serial 46083
    expect(res.rows[0].first_remittance_date).toBe("2026-03-20");
  });

  it("reports missing required columns with the headers it did find", () => {
    const res = parseDiligenceTable(table([row()], ["InvoiceNo", "ClaimStatus"]));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.header.missingRequired.sort()).toEqual(["claim_status", "invoice_no"]);
    expect(res.errors[0]).toEqual({ row: null, code: "missing_required_columns" });
  });

  it("rejects bad values by row and code, without echoing the value", () => {
    const res = parseDiligenceTable(
      table([
        row(),
        row({
          ClaimActivityNumber: "CA-TEST-2",
          TransactionDate: "31-02-2026",
          NetAmt: "SECRET-ABC",
          ClaimMonth: 13,
        }),
        row({ ClaimActivityNumber: "", InvoiceNo: "" }),
      ]),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors).toEqual(
      expect.arrayContaining([
        { row: 3, code: "invalid_date", field: "transaction_date" },
        { row: 3, code: "invalid_number", field: "net" },
        { row: 3, code: "out_of_range", field: "claim_month" },
        { row: 4, code: "blank_required", field: "claim_activity_number" },
        { row: 4, code: "blank_required", field: "invoice_no" },
      ]),
    );
    expect(JSON.stringify(res)).not.toContain("SECRET-ABC");
  });

  it("rejects duplicate claim activity numbers and duplicate headers", () => {
    const dup = parseDiligenceTable(table([row(), row()]));
    expect(dup.ok).toBe(false);
    if (!dup.ok)
      expect(dup.errors).toContainEqual({
        row: 3,
        code: "duplicate_claim_activity_number",
        field: "claim_activity_number",
      });

    const t = table();
    t[0].push("Claim Activity Number"); // second column that maps to the same field
    t[1].push("CA-X");
    const dh = parseDiligenceTable(t);
    expect(dh.ok).toBe(false);
    if (!dh.ok) expect(dh.header.duplicateHeaders).toEqual(["Claim Activity Number"]);
  });

  it("rejects an empty file and ignores fully blank rows", () => {
    const empty = parseDiligenceTable([Object.keys(BASE_ROW)]);
    expect(empty.ok).toBe(false);
    const withBlank = parseDiligenceTable([...table(), Object.keys(BASE_ROW).map(() => null)]);
    expect(withBlank.ok).toBe(true);
  });

  it("matches headers case- and separator-insensitively", () => {
    const t = table();
    t[0] = t[0].map((h) =>
      String(h)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase(),
    );
    expect(parseDiligenceTable(t).ok).toBe(true);
  });
});

describe("readXlsxTable (real .xlsx round trip)", () => {
  it("reads the DataSheet of a generated workbook, including typed cells", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Other").addRow(["ignore", "me"]);
    const ws = wb.addWorksheet("DataSheet");
    const t = table([row({ TransactionDate: new Date(Date.UTC(2026, 2, 2)), NetAmt: 100.5 })]);
    t.forEach((r) => ws.addRow(r));
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());

    const read = await readXlsxTable(buffer);
    const res = parseDiligenceTable(read);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toMatchObject({
      transaction_date: "2026-03-02",
      net: 100.5,
      claim_activity_number: "CA-TEST-1",
    });
    expect(JSON.stringify(res.rows)).not.toContain("Test Patient One");
  });
});
