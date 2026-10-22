/**
 * Phase 20C: the generic statement import. Only mapped columns are read, a missing mapped header refuses the whole file
 * (listing what is missing), errors never echo cell values, descriptions are redacted, and the layout check refuses
 * incomplete or clashing mappings. Files are built in the test (CSV text and an .xlsx made with exceljs); synthetic only.
 */
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { fieldsFor, validateMapping, type ImportFormat } from "@/lib/finance/import-kinds";
import {
  parseBankStatement,
  parseSettlement,
  readAmount,
  readDate,
  readImportFile,
} from "@/lib/finance/parse-import";
import { parseCsv } from "@/lib/finance/parse-remittance";
import { redactStatementText } from "@/lib/redact";

const SIGNED: ImportFormat = {
  kind: "bank_statement",
  mapping: {
    value_date: "Value Date",
    amount: "Amount",
    reference: "Ref",
    description: "Narrative",
  },
  dateFormat: "DD/MM/YYYY",
  amountStyle: "signed",
};
const DRCR: ImportFormat = {
  kind: "bank_statement",
  mapping: { value_date: "Date", credit: "Credit", debit: "Debit", description: "Details" },
  dateFormat: "YYYY-MM-DD",
  amountStyle: "debit_credit",
};
const SETTLE: ImportFormat = {
  kind: "settlement",
  mapping: {
    transaction_date: "Txn Date",
    settlement_date: "Payout Date",
    gross: "Gross",
    net: "Net",
    reference: "Payout ID",
  },
  dateFormat: "MM/DD/YYYY",
  amountStyle: "signed",
};

const csv = (text: string) => parseCsv(text);

describe("layouts", () => {
  it("lists the fields of each kind and style; the field list lives in code", () => {
    expect(fieldsFor("bank_statement", "signed").map((f) => [f.key, f.required])).toEqual([
      ["value_date", true],
      ["amount", true],
      ["reference", false],
      ["description", false],
    ]);
    expect(fieldsFor("bank_statement", "debit_credit").map((f) => f.key)).toEqual([
      "value_date",
      "credit",
      "debit",
      "reference",
      "description",
    ]);
    expect(
      fieldsFor("settlement", "signed")
        .filter((f) => f.required)
        .map((f) => f.key),
    ).toEqual(["transaction_date", "settlement_date", "gross", "net"]);
  });

  it("refuses a missing required field and two fields on one column, and drops fields of another style or kind", () => {
    expect(validateMapping("bank_statement", "signed", { value_date: "Date" })).toEqual({
      ok: false,
      error: 'Give the column header for "Amount (signed)".',
    });
    expect(
      validateMapping("bank_statement", "signed", { value_date: "Date", amount: " date " }).ok,
    ).toBe(false);
    expect(
      validateMapping("bank_statement", "signed", {
        value_date: " Value  Date ",
        amount: "Amount",
        credit: "Credit",
        patient_name: "Name",
      }),
    ).toEqual({ ok: true, mapping: { value_date: "Value Date", amount: "Amount" } });
  });
});

describe("scalars", () => {
  it("reads dates in the layout's format only, and never guesses a two-digit year", () => {
    expect(readDate("05/10/2026", "DD/MM/YYYY")).toBe("2026-10-05");
    expect(readDate("10/05/2026", "MM/DD/YYYY")).toBe("2026-10-05");
    expect(readDate("2026-10-05 14:22", "YYYY-MM-DD")).toBe("2026-10-05");
    expect(readDate("5.10.2026", "DD/MM/YYYY")).toBe("2026-10-05");
    expect(readDate("31/02/2026", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate("05/10/26", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate("2026-10-05", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate(new Date(Date.UTC(2026, 9, 5)), "DD/MM/YYYY")).toBe("2026-10-05");
    expect(readDate(46300, "DD/MM/YYYY")).toBe("2026-10-05"); // Excel serial
    expect(readDate("  ", "DD/MM/YYYY")).toBeNull();
  });

  it("reads a day, an English month name and a four-digit year in any layout", () => {
    expect(readDate("05-Jan-2026", "DD/MM/YYYY")).toBe("2026-01-05");
    expect(readDate("05-Jan-2026", "MM/DD/YYYY")).toBe("2026-01-05");
    expect(readDate("5 January 2026", "YYYY-MM-DD")).toBe("2026-01-05");
    expect(readDate("30-Sept-2026", "DD/MM/YYYY")).toBe("2026-09-30");
    expect(readDate("12-DEC-2025 10:15", "DD/MM/YYYY")).toBe("2025-12-12");
    expect(readDate("31-Feb-2026", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate("05-Janxyz-2026", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate("05-Foo-2026", "DD/MM/YYYY")).toBe("invalid");
    expect(readDate("05-Jan-26", "DD/MM/YYYY")).toBe("invalid");
  });

  it("reads amounts with thousands separators, a currency prefix and accounting brackets", () => {
    expect(readAmount("1,234.50")).toBe(1234.5);
    expect(readAmount("AED 975.00")).toBe(975);
    expect(readAmount("(12.30)")).toBe(-12.3);
    expect(readAmount(-500)).toBe(-500);
    expect(readAmount("12 Oct")).toBe("invalid");
    expect(readAmount("")).toBeNull();
  });
});

describe("redaction of statement text", () => {
  it("masks IBANs, card and account numbers, phone numbers and e-mails, and keeps short references", () => {
    expect(redactStatementText("TRANSFER FROM AE07 0331 2345 6789 0123 456 SALARY")).toBe(
      "TRANSFER FROM [iban] SALARY",
    );
    expect(redactStatementText("TRF AE070331234567890123456")).toBe("TRF [iban]");
    expect(redactStatementText("POS 4111 1111 1111 1111 DXB")).toBe("POS •••• 1111 DXB");
    expect(redactStatementText("CARD 411111******1234 PURCHASE")).toBe("CARD •••• 1234 PURCHASE");
    expect(redactStatementText("A/C 0123456789012 CREDIT")).toBe("A/C •••• 9012 CREDIT");
    expect(redactStatementText("CALL +971 50 123 4567")).not.toMatch(/123 4567/);
    expect(redactStatementText("ref to someone@example.test")).toBe("ref to [email]");
    expect(redactStatementText("DAMAN RA-55501 FT2628312345 TBY-7781")).toBe(
      "DAMAN RA-55501 FT2628312345 TBY-7781",
    );
    expect(redactStatementText("  ")).toBeNull();
    expect(redactStatementText("x".repeat(300), 200)).toHaveLength(200);
  });

  it("masks local UAE phone numbers (no +): mobiles, landlines and the 971 / 00971 forms", () => {
    // synthetic numbers in the style of the reserved demo range (900 block); none is a real line
    for (const [text, kept] of [
      ["MOB 0509000001 PAYMENT", /9000001|0509/],
      ["MOB0509000001", /9000001/],
      ["TEL 050 900 0002 REF RA-55501", /900 0002|0002/],
      ["CALL 050-900-0003", /900-0003/],
      ["LANDLINE 04 900 0004", /900 0004/],
      ["TEL 049000005 DXB", /9000005/],
      ["971509000006 TRANSFER", /9000006/],
      ["9714 900 0007", /900 0007/],
      ["00971509000008", /9000008/],
      ["MOB 971 50 900 0009", /900 0009/],
    ] as const) {
      const out = redactStatementText(text) ?? "";
      expect(out, text).not.toMatch(kept);
      expect(out, text).toContain("•");
    }
    // the reference next to the number survives
    expect(redactStatementText("TEL 050 900 0002 REF RA-55501")).toContain("RA-55501");
    // references with letters and digits, dates and short or non-zero-leading numbers are kept
    for (const text of [
      "DAMAN RA-55501 FT2628312345 TBY-7781",
      "INV-2026-0042 05/10/2026",
      "BATCH 0012345 AMT 1500.00",
      "REMIT 123456789",
    ])
      expect(redactStatementText(text), text).toBe(text);
  });
});

describe("bank statements", () => {
  const FILE = [
    "Account statement,,,,,",
    "Account,••••4321,,,,",
    ",,,,,",
    "Value Date,Narrative,Ref,Amount,Balance,Customer Name",
    "05/10/2026,CARD SETTLEMENT 4111 1111 1111 1111,MID-778,975.00,10975.00,Should Never Be Read",
    '06/10/2026,RENT,,"-1,500.00",9475.00,Should Never Be Read',
    ",Opening balance,,,9475.00,",
    "07/10/2026,EPG PAYOUT,,0,9475.00,",
  ].join("\n");

  it("finds the header below the preamble, reads only the mapped columns and redacts the text", () => {
    const r = parseBankStatement(csv(FILE), SIGNED);
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          value_date: "2026-10-05",
          amount: 975,
          reference: "MID-778",
          description: "CARD SETTLEMENT •••• 1111",
        },
        { value_date: "2026-10-06", amount: -1500, reference: null, description: "RENT" },
      ],
      stats: {
        rows: 2,
        skipped: 2,
        credits: 975,
        debits: 1500,
        firstDate: "2026-10-05",
        lastDate: "2026-10-06",
      },
    });
    expect(JSON.stringify(r)).not.toMatch(/Never|10975|9475/);
  });

  it("refuses the whole file when a mapped header is missing, and lists it", () => {
    const r = parseBankStatement(csv(FILE.replace("Narrative", "Details")), SIGNED);
    expect(r).toEqual({
      ok: false,
      missing: ["Narrative (Description)"],
      errors: ["The file is missing 1 mapped column(s)."],
    });
  });

  it("matches headers ignoring case and spacing, but refuses a mapped header that appears twice", () => {
    expect(
      parseBankStatement(csv("value  date,AMOUNT,ref,narrative\n05/10/2026,1,,x"), SIGNED).ok,
    ).toBe(true);
    const twice = parseBankStatement(
      csv("Value Date,Amount,Ref,Narrative,Amount\n05/10/2026,1,,x,2"),
      SIGNED,
    );
    expect(twice).toMatchObject({
      ok: false,
      errors: ['The column "Amount" appears twice in the header row.'],
    });
  });

  it("refuses unreadable rows with their row number and never echoes the cell", () => {
    const r = parseBankStatement(
      csv(
        "Value Date,Amount,Ref,Narrative\n2026-10-05,975,SECRET-REF,x\n05/10/2026,abc,,y\n,12,,z\n06/10/2026,,,w",
      ),
      SIGNED,
    );
    expect(r).toEqual({
      ok: false,
      missing: [],
      errors: [
        "Row 2: the value date is not a date in DD/MM/YYYY.",
        "Row 3: Amount (signed) is not a number.",
        "Row 4: an amount without a value date.",
        "Row 5: a value date without an amount.",
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|abc/);
  });

  it("reads separate debit and credit columns, refuses a row with both, and refuses an empty file", () => {
    const ok = parseBankStatement(
      csv(
        "Date,Details,Debit,Credit\n2026-10-05,IN,,975.00\n2026-10-06,OUT,1500.00,\n2026-10-07,OUT,-20,",
      ),
      DRCR,
    );
    expect(ok.ok && ok.rows.map((x) => x.amount)).toEqual([975, -1500, -20]);
    const both = parseBankStatement(csv("Date,Details,Debit,Credit\n2026-10-05,X,1,2"), DRCR);
    expect(both).toMatchObject({ ok: false, errors: ["Row 2: both a debit and a credit."] });
    expect(parseBankStatement(csv("Date,Details,Debit,Credit\n,,,"), DRCR)).toMatchObject({
      ok: false,
      errors: ["The file has no data rows."],
    });
  });

  it("refuses a layout of the wrong kind or one missing a required field", () => {
    expect(parseBankStatement(csv(FILE), SETTLE).ok).toBe(false);
    const broken = { ...SIGNED, mapping: { value_date: "Value Date" } };
    expect(parseBankStatement(csv(FILE), broken)).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/does not map: Amount/)],
    });
  });

  it("reads an .xlsx (first sheet, real date cells and numbers)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Statement");
    ws.addRow(["Bank X statement"]);
    ws.addRow(["Value Date", "Narrative", "Ref", "Amount", "Customer Name"]);
    ws.addRow([
      new Date(Date.UTC(2026, 9, 5)),
      "CARD SETTLEMENT",
      "MID-778",
      975,
      "Should Never Be Read",
    ]);
    ws.addRow(["06/10/2026", "EPG PAYOUT", null, 490.5, null]);
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    const r = parseBankStatement(await readImportFile(buffer), SIGNED);
    expect(r.ok && r.rows).toEqual([
      {
        value_date: "2026-10-05",
        amount: 975,
        reference: "MID-778",
        description: "CARD SETTLEMENT",
      },
      { value_date: "2026-10-06", amount: 490.5, reference: null, description: "EPG PAYOUT" },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/Never/);
  });

  it("reads CSV bytes as text", async () => {
    const r = parseBankStatement(await readImportFile(Buffer.from(FILE, "utf8")), SIGNED);
    expect(r.ok).toBe(true);
  });
});

describe("settlement reports", () => {
  it("reads payouts; the fee is gross minus net when there is no fee column", () => {
    const r = parseSettlement(
      csv(
        "Txn Date,Payout Date,Gross,Net,Payout ID,Customer\n10/08/2026,10/16/2026,600.00,570.00,TBY-7781,X\n10/09/2026,10/16/2026,350,332.5,TBY-7781,Y",
      ),
      SETTLE,
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        {
          txn_date: "2026-10-08",
          settlement_date: "2026-10-16",
          gross: 600,
          net: 570,
          fee: 30,
          reference: "TBY-7781",
        },
        {
          txn_date: "2026-10-09",
          settlement_date: "2026-10-16",
          gross: 350,
          net: 332.5,
          fee: 17.5,
          reference: "TBY-7781",
        },
      ],
      stats: {
        rows: 2,
        skipped: 0,
        credits: 902.5,
        debits: 0,
        firstDate: "2026-10-08",
        lastDate: "2026-10-09",
      },
    });
  });

  it("needs both dates, gross and net on every row", () => {
    const r = parseSettlement(
      csv("Txn Date,Payout Date,Gross,Net,Payout ID\n10/08/2026,,600,570,A"),
      SETTLE,
    );
    expect(r).toMatchObject({
      ok: false,
      errors: ["Row 2: both dates are needed, in MM/DD/YYYY."],
    });
  });
});
