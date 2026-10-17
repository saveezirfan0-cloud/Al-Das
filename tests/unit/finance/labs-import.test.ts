/**
 * Slice 20E: lab and provider files through the generic import engine (20C). The two kinds have no field for a name,
 * date of birth, Emirates ID or member id, so such a column can never be mapped or read; a file missing a mapped column
 * is refused; every text value must look like what it is (so a name mapped as a PIN refuses the file); errors never echo
 * cell values. Files are built in the test; the names in them are synthetic and must not appear in any output.
 */
import { describe, expect, it } from "vitest";

import {
  BANK_IMPORT_KINDS,
  fieldsFor,
  IMPORT_KIND_KEYS,
  IMPORT_KINDS,
  LAB_IMPORT_KINDS,
  RECEIPT_IMPORT_KINDS,
  validateMapping,
  type ImportFormat,
} from "@/lib/finance/import-kinds";
import { parseProviderLines } from "@/lib/finance/parse-import";
import { parseCsv } from "@/lib/finance/parse-remittance";

const ACTIVITY: ImportFormat = {
  kind: "lab_activity",
  mapping: {
    service_date: "Sample Date",
    test_code: "CPT",
    patient_pin: "MRN",
    doctor_dha_id: "Ref Doctor",
    branch: "Clinic",
    result_date: "Reported",
  },
  dateFormat: "DD/MM/YYYY",
  amountStyle: "signed",
};
const INVOICE: ImportFormat = {
  kind: "provider_invoice",
  mapping: {
    service_date: "Date",
    test_code: "Code",
    amount: "Charge",
    patient_pin: "PIN",
    invoice_number: "Inv No",
  },
  dateFormat: "YYYY-MM-DD",
  amountStyle: "signed",
};

const FILE = [
  "Lab report October,,,,,,,,",
  "Sample Date,Patient Name,Emirates ID,DOB,MRN,CPT,Ref Doctor,Clinic,Reported",
  "05/10/2026,Layla Demo-07,784-0000-0000000-0,01/01/1990,SYN-001,85025,DHA-SYN-1,Palm,06/10/2026",
  "06/10/2026,Omar Demo-08,784-0000-0000000-1,02/02/1980,syn-002,80053,,,",
  ",,,,,,,,",
  ",Total,,,,,,,",
].join("\n");

describe("lab and provider field lists", () => {
  it("exist next to the bank kinds and have no name or ID-number field", () => {
    expect([...IMPORT_KIND_KEYS]).toEqual([
      ...BANK_IMPORT_KINDS,
      ...LAB_IMPORT_KINDS,
      ...RECEIPT_IMPORT_KINDS,
    ]);
    const forbidden =
      /name|birth|dob|emirates|passport|national|member|insur|phone|e-?mail|address/i;
    for (const kind of LAB_IMPORT_KINDS)
      for (const [key, spec] of Object.entries(IMPORT_KINDS[kind].fields)) {
        expect(key, `${kind}.${key}`).not.toMatch(forbidden);
        expect(spec.label, `${kind}.${key}`).not.toMatch(forbidden);
      }
    expect(fieldsFor("lab_activity", "signed").map((f) => [f.key, f.required])).toEqual([
      ["service_date", true],
      ["test_code", true],
      ["patient_pin", false],
      ["doctor_dha_id", false],
      ["branch", false],
      ["result_date", false],
    ]);
    expect(fieldsFor("provider_invoice", "signed").map((f) => [f.key, f.required])).toEqual([
      ["service_date", true],
      ["test_code", true],
      ["amount", true],
      ["patient_pin", false],
      ["doctor_dha_id", false],
      ["branch", false],
      ["result_date", false],
      ["invoice_number", false],
    ]);
  });

  it("a layout cannot map a field the kind does not have (a typed patient_name is dropped)", () => {
    const v = validateMapping("lab_activity", "signed", {
      service_date: "Sample Date",
      test_code: "CPT",
      patient_name: "Patient Name",
      emirates_id: "Emirates ID",
    });
    expect(v).toEqual({ ok: true, mapping: { service_date: "Sample Date", test_code: "CPT" } });
    expect(
      validateMapping("provider_invoice", "signed", { service_date: "D", test_code: "C" }),
    ).toEqual({
      ok: false,
      error: 'Give the column header for "Amount charged".',
    });
  });
});

describe("parseProviderLines", () => {
  it("reads only the mapped columns: names, Emirates IDs and dates of birth in the file never come out", () => {
    const r = parseProviderLines(parseCsv(FILE), ACTIVITY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toEqual([
      {
        service_date: "2026-10-05",
        code: "85025",
        patient_pin: "SYN-001",
        doctor_dha_id: "DHA-SYN-1",
        branch: "Palm",
        result_date: "2026-10-06",
        amount: null,
        invoice_no: null,
      },
      {
        service_date: "2026-10-06",
        code: "80053",
        patient_pin: "SYN-002",
        doctor_dha_id: null,
        branch: null,
        result_date: null,
        amount: null,
        invoice_no: null,
      },
    ]);
    expect(r.stats).toMatchObject({
      rows: 2,
      skipped: 2,
      firstDate: "2026-10-05",
      lastDate: "2026-10-06",
    });
    const out = JSON.stringify(r);
    for (const secret of ["Layla", "Omar", "784-", "1990", "1980"])
      expect(out).not.toContain(secret);
  });

  it("refuses the whole file when a mapped column is missing, listing it", () => {
    const r = parseProviderLines(parseCsv(FILE), {
      ...ACTIVITY,
      mapping: { ...ACTIVITY.mapping, result_date: "Result Date" },
    });
    expect(r).toEqual({
      ok: false,
      missing: ["Result Date (Result date)"],
      errors: ["The file is missing 1 mapped column(s)."],
    });
  });

  it("refuses a file whose PIN column holds names (a wrongly mapped column), without echoing them", () => {
    const r = parseProviderLines(parseCsv(FILE), {
      ...ACTIVITY,
      mapping: { ...ACTIVITY.mapping, patient_pin: "Patient Name" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toBe("Row 3: Unite PIN does not look like a Unite PIN.");
    expect(JSON.stringify(r)).not.toMatch(/Layla|Omar/);
  });

  it("checks codes, doctor ids, dates, amounts and invoice numbers", () => {
    const head = "Date,Code,Charge,PIN,Inv No";
    const bad = (row: string) => {
      const r = parseProviderLines(parseCsv(`${head}\n${row}`), INVOICE);
      return r.ok ? "ok" : r.errors[0];
    };
    expect(bad("2026-10-05,85025,35.00,SYN-1,INV-1")).toBe("ok");
    expect(bad("2026-10-05,CBC test,35,SYN-1,INV-1")).toBe(
      "Row 2: Test or service code (CPT or Unite item code) is missing or not a code.",
    );
    expect(bad("2026-10-05,85025,,SYN-1,INV-1")).toBe("Row 2: the amount is missing.");
    expect(bad("2026-10-05,85025,-5,SYN-1,INV-1")).toBe(
      "Row 2: a negative amount (credit lines are not accepted).",
    );
    expect(bad("05/10/2026,85025,5,SYN-1,INV-1")).toBe(
      "Row 2: the service date is missing or not in YYYY-MM-DD.",
    );
    expect(bad("2026-10-05,85025,5,SYN-1,INV 1 Layla")).toBe(
      "Row 2: Invoice number is not an invoice number.",
    );
    // the send-out lab's own shapes: composite codes and "Req:" voucher numbers (kept whole, never split)
    expect(bad("2026-10-05,87177+87209,35.00,SYN-1,Req:19998")).toBe("ok");
    expect(bad("2026-10-05,87070X3+87186,35.00,SYN-1,INV-1")).toBe("ok");
    expect(bad("2026-10-05,87177 + 87209,35.00,SYN-1,INV-1")).toBe(
      "Row 2: Test or service code (CPT or Unite item code) is missing or not a code.",
    );
    expect(bad("2026-10-05,85025,5,ABC,INV-1")).toBe(
      "Row 2: Unite PIN does not look like a Unite PIN.",
    );
    const late = parseProviderLines(
      parseCsv("Sample Date,CPT,Reported\n05/10/2026,85025,04/10/2026"),
      {
        ...ACTIVITY,
        mapping: { service_date: "Sample Date", test_code: "CPT", result_date: "Reported" },
      },
    );
    expect(late.ok ? "ok" : late.errors[0]).toBe(
      "Row 2: the result date is before the service date.",
    );
  });

  it("refuses bank layouts", () => {
    expect(parseProviderLines([["x"]], { ...INVOICE, kind: "bank_statement" })).toEqual({
      ok: false,
      missing: [],
      errors: ["This layout is not for lab or provider files."],
    });
  });
});
