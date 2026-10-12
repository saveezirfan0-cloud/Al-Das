import { describe, expect, it } from "vitest";

import {
  looksLikeXlsx,
  parseCsv,
  parseRemittanceTable,
  readRemittanceFile,
} from "@/lib/finance/parse-remittance";

const HEAD = [
  "RemittanceID",
  "PaymentDate",
  "PayerID",
  "ClaimActivityNumber",
  "InvoiceNo",
  "CPTCode",
  "Quantity",
  "ClaimedAmount",
  "PaidAmount",
  "DeniedAmount",
  "DenialCode",
];
const ROW = [
  "RM-1",
  "01-10-2026",
  "PAYER-A",
  "CA-R-1",
  "ADMC/C/70001",
  "99213",
  1,
  200,
  180,
  0,
  "",
];

describe("parseRemittanceTable", () => {
  it("parses a valid advice and reports sums", () => {
    const res = parseRemittanceTable([
      HEAD,
      ROW,
      [
        "RM-1",
        "01-10-2026",
        "PAYER-A",
        "CA-R-2",
        "ADMC/C/70002",
        "99214",
        1,
        300,
        "240.50",
        50,
        "AUTH-001",
      ],
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0]).toMatchObject({
      remittance_ref: "RM-1",
      paid_on: "2026-10-01",
      claim_activity_number: "CA-R-1",
      paid_amount: 180,
      denied_amount: 0,
      denial_code: null,
    });
    expect(res.rows[1]).toMatchObject({
      paid_amount: 240.5,
      denied_amount: 50,
      denial_code: "AUTH-001",
    });
    expect(res.stats).toMatchObject({
      rows: 2,
      sumPaid: 420.5,
      sumDenied: 50,
      refs: 1,
      minPaidOn: "2026-10-01",
    });
  });

  it("never keeps sensitive or unknown columns, and says it dropped them", () => {
    const res = parseRemittanceTable([
      [...HEAD, "PatientName", "MemberID", "EmiratesID", "Surprise"],
      [...ROW, "Test Person", "MEMBER-1", "784-0000", "x"],
    ]);
    if (!res.ok) throw new Error("expected ok");
    const json = JSON.stringify(res.rows);
    for (const secret of ["Test Person", "MEMBER-1", "784-0000"])
      expect(json).not.toContain(secret);
    expect(res.header.droppedSensitive).toEqual(
      expect.arrayContaining(["PatientName", "MemberID", "EmiratesID"]),
    );
    expect(res.header.unrecognised).toEqual(["Surprise"]);
  });

  it("fails closed on missing required columns, no way to identify claims, and empty files", () => {
    const noPaid = parseRemittanceTable([HEAD.filter((h) => h !== "PaidAmount"), ROW.slice(0, 8)]);
    expect(noPaid.ok).toBe(false);
    if (!noPaid.ok) expect(noPaid.errors[0].code).toBe("missing_required_columns");
    const noId = parseRemittanceTable([
      ["RemittanceID", "PaidAmount"],
      ["RM-1", 5],
    ]);
    expect(noId.ok).toBe(false);
    if (!noId.ok) expect(noId.errors.map((e) => e.code)).toContain("no_way_to_identify_claims");
    expect(parseRemittanceTable([HEAD]).ok).toBe(false);
  });

  it("reports row-level problems with row numbers and codes but never values", () => {
    const res = parseRemittanceTable([
      HEAD,
      ["RM-1", "99-99-9999", "P", "CA-1", "", "", "", "", "abc", "", ""],
      ["", "01-10-2026", "P", "CA-2", "", "", "", "", 5, "", ""],
      ["RM-1", "01-10-2026", "P", "", "", "", "", "", -5, "", ""],
    ]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    const codes = res.errors.map((e) => `${e.row}:${e.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "2:invalid_date",
        "2:invalid_number",
        "3:blank_required",
        "4:negative_amount",
        "4:unidentifiable_line",
      ]),
    );
    expect(JSON.stringify(res.errors)).not.toContain("abc");
  });

  it("a blank paid amount is an error, never 0", () => {
    const res = parseRemittanceTable([
      HEAD,
      ["RM-1", "01-10-2026", "P", "CA-1", "", "", "", "", "", "", ""],
    ]);
    expect(res.ok).toBe(false);
  });
});

describe("file readers", () => {
  it("reads CSV with quotes, a BOM, CRLF and a semicolon delimiter", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
    ]);
    expect(parseCsv("a;b\n1;2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(parseCsv("a\tb\n1\t2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("reads a synthetic .xlsx workbook built in the test, and a CSV, to the same result", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Remittance");
    ws.addRow(HEAD);
    ws.addRow(ROW);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    expect(looksLikeXlsx(xlsx)).toBe(true);
    const fromXlsx = parseRemittanceTable(await readRemittanceFile(xlsx));
    const csv = Buffer.from([HEAD.join(","), ROW.join(",")].join("\n"), "utf8");
    expect(looksLikeXlsx(csv)).toBe(false);
    const fromCsv = parseRemittanceTable(await readRemittanceFile(csv));
    expect(fromXlsx.ok && fromCsv.ok).toBe(true);
    if (fromXlsx.ok && fromCsv.ok) expect(fromXlsx.rows).toEqual(fromCsv.rows);
  });
});
