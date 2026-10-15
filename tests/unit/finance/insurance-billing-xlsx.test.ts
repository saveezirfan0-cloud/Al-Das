import { describe, expect, it } from "vitest";

import { buildInsuranceBilling, parseReconInputs } from "@/lib/finance/insurance-billing";
import { insuranceBillingWorkbook } from "@/lib/finance/insurance-billing-xlsx";

const raw = {
  month: "2026-09-01",
  unreported_shown: true,
  coverage: [{ from: "2026-09-01", to: "2026-09-15" }],
  settings: { tolerance: 1, grace_days: 7 },
  summary: { billed: 900, billed_rows: 4, cancelled_rows: 1, cancelled_amount: 40 },
  invoices: [
    {
      key: "INS-SYN-001",
      invoice_no: "INS-SYN-001",
      billed: 300,
      rows: 1,
      first_date: "2026-09-02",
      last_date: "2026-09-02",
      pairs: 1,
      visible_pairs: [{ branch: "PJ", doctor: "Dr Demo-01" }],
      submitted: 280,
      activities: 1,
      payers: ["SYN-P1"],
    },
    {
      key: "INS-SYN-002",
      invoice_no: "INS-SYN-002",
      billed: 400,
      rows: 1,
      first_date: "2026-09-01",
      last_date: "2026-09-01",
      pairs: 1,
      visible_pairs: [{ branch: "GM", doctor: "Dr Demo-02" }],
      submitted: null,
      activities: 0,
      payers: [],
    },
    {
      key: "=CMD()",
      invoice_no: "=CMD()",
      billed: 200,
      rows: 2,
      first_date: "2026-09-03",
      last_date: "2026-09-03",
      pairs: 2,
      visible_pairs: [{ branch: "PJ", doctor: "Dr Demo-01" }],
      submitted: null,
      activities: 0,
      payers: [],
    },
  ],
  unreported: [
    {
      key: "INS-SYN-101",
      invoice_no: "INS-SYN-101",
      submitted: 80,
      activities: 1,
      first_date: "2026-09-09",
      payers: [],
      report_month: "2026-08-01",
      cancelled_in_report: false,
    },
  ],
};

describe("insurance billed vs claimed workbook", () => {
  it("has the six sheets with Pulse's values and no formulas, and no patient data", async () => {
    const report = buildInsuranceBilling(parseReconInputs(raw), "2026-09-20");
    const buf = await insuranceBillingWorkbook({
      org: "Synthetic Clinic",
      report,
      branchLabel: "All branches",
      builtAt: "2026-09-20T06:00:00.000Z",
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Billed not submitted",
      "Matched",
      "Not in report",
      "Ambiguous",
      "Definitions",
    ]);

    let formulas = 0;
    const cells = (name: string) => {
      const out: unknown[] = [];
      wb.getWorksheet(name)!.eachRow((r) =>
        r.eachCell((c) => {
          if (
            c.formula ||
            (typeof c.value === "object" && c.value !== null && "formula" in c.value)
          )
            formulas++;
          out.push(c.value);
        }),
      );
      return out;
    };
    const all = wb.worksheets.map((w) => cells(w.name));
    expect(formulas).toBe(0);

    expect(cells("Summary")).toEqual(expect.arrayContaining([900, 400, 280]));
    expect(
      cells("Summary").some((v) => typeof v === "string" && v.includes("partly covered")),
    ).toBe(true);
    expect(cells("Billed not submitted")).toEqual(
      expect.arrayContaining(["INS-SYN-002", 19, 400, "GM: Dr Demo-02"]),
    );
    expect(cells("Matched")).toEqual(
      expect.arrayContaining(["INS-SYN-001", 300, 280, 20, "Yes", "SYN-P1"]),
    );
    expect(cells("Not in report")).toEqual(expect.arrayContaining(["INS-SYN-101", 80, "2026-08"]));
    // an invoice number that looks like a formula stays text
    expect(cells("Ambiguous")).toEqual(expect.arrayContaining(["=CMD()", 2]));
    expect(cells("Definitions")).toContain("Billed, not submitted");

    expect(JSON.stringify(all)).not.toMatch(/9000000\d\d|P-syn|patient_ref|\bpin\b/i);
  });

  it("explains the missing unreported list when a branch filter applies", async () => {
    const report = buildInsuranceBilling(
      parseReconInputs({ ...raw, unreported_shown: false, branch: "PJ" }),
      "2026-09-20",
    );
    const buf = await insuranceBillingWorkbook({
      org: "Synthetic Clinic",
      report,
      branchLabel: "Palm",
      builtAt: "2026-09-20T06:00:00.000Z",
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const values: unknown[] = [];
    wb.getWorksheet("Not in report")!.eachRow((r) => r.eachCell((c) => values.push(c.value)));
    expect(values).not.toContain("INS-SYN-101");
    expect(
      values.some(
        (v) => typeof v === "string" && v.includes("Diligence activities have no branch"),
      ),
    ).toBe(true);
  });
});
