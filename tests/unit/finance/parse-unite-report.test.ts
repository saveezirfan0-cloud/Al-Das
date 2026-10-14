import { describe, expect, it } from "vitest";

import { parseUniteReport, UniteReportError } from "@/lib/finance/parse-unite-report";
import {
  amountMils,
  normaliseDoctorKey,
  recordCancelled,
  visitStatus,
} from "@/lib/finance/unite-report-mapping";

import {
  buildUniteReportWorkbook,
  DEFAULT_ROWS,
  RAW_HEADERS,
  SENTINELS,
  wall,
} from "./fixtures/unite-report-workbook";

const rejection = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(UniteReportError);
  return (e as Error).message;
};

describe("parseUniteReport (synthetic workbook)", () => {
  it("reads the date range, the rows and the report totals", async () => {
    const r = await parseUniteReport(await buildUniteReportWorkbook());
    expect(r.fromDate).toBe("2026-09-01");
    expect(r.toDate).toBe("2026-09-30");
    expect(r.rows).toHaveLength(5); // the footer line without S.NO is not a row

    const [selfPay, unbilled, invoiceOnly, cancelled, drift] = r.rows;
    expect(selfPay).toMatchObject({
      row_no: 2,
      visit_at: "2026-09-01T05:15:00.000Z",
      invoice_date: "2026-09-01",
      report_date: "2026-09-01",
      department: "Dermatology",
      doctor_name: "Dr. Omar Testdoc",
      doctor_key: "omar testdoc",
      clinic_name: "Al Das Synthetic Clinic One",
      patient_pin: "900000001",
      visit_status: "new",
      invoice_type: "SELF PAID",
      selfpay_invoice_no: "SP-0001",
      insurance_invoice_no: null,
      categories: { PROCEDURES: 500 },
      gross: 500,
      discount: 50,
      vat: 22.5,
      net: 450,
      total: 472.5,
      cash: 472.5,
      is_cancelled: false,
    });

    // 02:00 in Dubai is 22:00 UTC the day before; the report date is the Dubai date
    expect(unbilled).toMatchObject({
      visit_at: "2026-08-31T22:00:00.000Z",
      invoice_date: null,
      report_date: "2026-09-01",
      doctor_key: "omar testdoc",
      patient_pin: "900000002",
      visit_status: "revisit",
      selfpay_invoice_no: null,
      insurance_invoice_no: null,
      invoice_type: null,
      net: 0,
      categories: {},
    });

    expect(invoiceOnly).toMatchObject({
      visit_at: null,
      invoice_date: "2026-09-15",
      report_date: "2026-09-15",
      doctor_name: "dr omar testdoc",
      doctor_key: "omar testdoc",
      visit_status: "followup",
      categories: { NO: 100, Package: 200, PACKAGES: 300 },
      patient_share: 63,
      insurance_claim: 567,
      is_cancelled: false,
    });

    // the first PAYMENT GATEWAY / OTHERS (invoice section) are read, not the collection section's 999 / 888
    expect(cancelled).toMatchObject({
      is_cancelled: true,
      invoice_type: "INSURANCE, SELF PAID",
      payment_gateway: 50,
      other_payment: 55,
      categories: { TEST: 80.25, "DENTAL PROCEDURES": 19.75 },
      visit_at: "2026-09-30T17:00:00.000Z",
      report_date: "2026-09-30",
    });

    expect(drift).toMatchObject({
      doctor_name: "Dr. Sara Example",
      doctor_key: "sara example",
      patient_pin: null,
      visit_status: null,
      cash: 0.1,
      bank_transfer: 0.2,
      advance_consumed: 3,
      credit_note_consumed: 4,
      outstanding_credit: 5,
      write_off: 2,
      refund: 1,
    });
  });

  it("reconciles every one of the 12 columns to the fils (cancelled rows included)", async () => {
    const r = await parseUniteReport(await buildUniteReportWorkbook());
    expect(r.reconciled).toBe(true);
    expect(r.problems).toEqual([]);
    expect(r.rowTotals).toEqual(r.reportTotals);
    expect(r.reportTotals).toMatchObject({
      gross: 1200.3,
      net: 1150.3,
      total: 1207.8,
      cash: 472.6,
      bank_transfer: 0.2,
      payment_gateway: 50,
      other_payment: 55,
    });
  });

  it("keeps Unite's three-decimal amounts and still reconciles to the fils", async () => {
    // the real September export has rows such as 178799.245 and 125662.975: rounding each row to the fils first
    // drifts the sum by 0.01 and would refuse a correct file
    const rows = DEFAULT_ROWS.map((r, i) =>
      i === 0
        ? { ...r, gross: 178799.245, net: 176290.745 }
        : i === 2
          ? { ...r, gross: 125662.975, net: 123278.375 }
          : r,
    );
    const r = await parseUniteReport(await buildUniteReportWorkbook({ rows }));
    expect(r.problems).toEqual([]);
    expect(r.reconciled).toBe(true);
    expect(r.rowTotals).toEqual(r.reportTotals);
    expect(r.rows[0]).toMatchObject({ gross: 178799.245, net: 176290.745 });
  });

  it("does not reconcile when a report total is off by one fils, and names the column", async () => {
    const r = await parseUniteReport(
      await buildUniteReportWorkbook({ tamper: { "Net Billing": 0.01 } }),
    );
    expect(r.reconciled).toBe(false);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("Net Billing");
    expect(r.rows).toHaveLength(5);
  });

  it("never returns a value from a column it must not read", async () => {
    const r = await parseUniteReport(await buildUniteReportWorkbook());
    const out = JSON.stringify(r);
    for (const s of Object.values(SENTINELS)) expect(out).not.toContain(s);
    expect(out).not.toContain("SENTINEL");
    expect(out).not.toContain("999");
    expect(out).not.toContain("888");
  });

  it("keeps a row without a doctor and says so", async () => {
    const r = await parseUniteReport(
      await buildUniteReportWorkbook({ cells: [{ row: 0, header: "DOCTOR NAME", value: " " }] }),
    );
    expect(r.rows[0]).toMatchObject({ doctor_name: "(no doctor)", doctor_key: "(no doctor)" });
    expect(r.reconciled).toBe(true);
    expect(r.problems).toEqual(["1 rows have no doctor name; they are kept as '(no doctor)'."]);
  });

  it("fails closed when a required column is missing", async () => {
    const msg = await rejection(
      parseUniteReport(await buildUniteReportWorkbook({ omitHeader: "NET BILLING" })),
    );
    expect(msg).toContain("NET BILLING");
  });

  it("fails closed on a visit status it does not know, without the value", async () => {
    const msg = await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 1, header: "STATUS", value: "Walk-in-XYZ" }],
        }),
      ),
    );
    expect(msg).toContain("RawData row 3");
    expect(msg).toContain("STATUS");
    expect(msg).not.toContain("XYZ");
  });

  it("fails closed on a record status it does not know", async () => {
    await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({ cells: [{ row: 0, header: "Status", value: "Hold" }] }),
      ),
    );
  });

  it("fails closed when a row is dated outside the report range", async () => {
    const msg = await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 2, header: "INVOICE DATE", value: wall(2026, 10, 1) }],
        }),
      ),
    );
    expect(msg).toContain("1 rows dated outside the report range");
  });

  it("fails closed on a non-numeric amount without leaking the cell", async () => {
    const msg = await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 3, header: "CASH", value: "Layla Demo-07 paid" }],
        }),
      ),
    );
    expect(msg).toBe("RawData row 5: 'CASH' is not a number.");
  });

  it("fails closed on a non-numeric category amount", async () => {
    const msg = await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 0, header: "TEST", value: "n/a-secret" }],
        }),
      ),
    );
    expect(msg).toContain("'TEST'");
    expect(msg).not.toContain("secret");
  });

  it("fails closed when a row has neither date, or a date cell holds text", async () => {
    await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 2, header: "INVOICE DATE", value: null }],
        }),
      ),
    );
    const msg = await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          cells: [{ row: 0, header: "VISIT DATE", value: "tomorrow" }],
        }),
      ),
    );
    expect(msg).not.toContain("tomorrow");
  });

  it("refuses a known personal column inside the category block", async () => {
    const headers = [...RAW_HEADERS];
    headers.splice(headers.indexOf("GROSS AMT"), 0, "PATIENT NAME");
    await rejection(parseUniteReport(await buildUniteReportWorkbook({ headers })));
  });

  it("refuses a workbook without a title, without an Invoice Total row, or that is not xlsx", async () => {
    await rejection(parseUniteReport(await buildUniteReportWorkbook({ title: "Something else" })));
    await rejection(parseUniteReport(Buffer.from("not a workbook")));
    await rejection(
      parseUniteReport(
        await buildUniteReportWorkbook({
          title: "Daily Collection from 30-Sep-2026 to 01-Sep-2026 | Generated On: x",
        }),
      ),
    );
  });

  it("tolerates single or double spaces in the title", async () => {
    const r = await parseUniteReport(
      await buildUniteReportWorkbook({
        title: "Daily Collection from 1-Sep-2026 to 30-Sep-2026",
      }),
    );
    expect([r.fromDate, r.toDate]).toEqual(["2026-09-01", "2026-09-30"]);
  });

  it("uses the synthetic default rows only", () => {
    expect(DEFAULT_ROWS.every((r) => r.pin === null || String(r.pin).startsWith("90000000"))).toBe(
      true,
    );
  });
});

describe("unite-report-mapping helpers", () => {
  it("normalises doctor names to one key", () => {
    for (const n of [
      "Dr. Latife cilli",
      "Dr.Latife Cilli",
      "dr latife  cilli",
      "DR. Latife Cilli",
      "Latife Cilli",
    ])
      expect(normaliseDoctorKey(n)).toBe("latife cilli");
    expect(normaliseDoctorKey("Drew Smith")).toBe("drew smith");
    expect(normaliseDoctorKey("Dr. A.B. Example")).toBe("ab example");
  });

  it("maps visit and record statuses through closed lists", () => {
    expect(visitStatus("New")).toBe("new");
    expect(visitStatus(" Revisit ")).toBe("revisit");
    expect(visitStatus("Followup")).toBe("followup");
    expect(visitStatus("Follow up")).toBe("followup");
    expect(visitStatus("FOLLOW-UP")).toBe("followup");
    expect(visitStatus("")).toBeNull();
    expect(visitStatus("Other")).toBe("invalid");
    expect(recordCancelled("Cancel")).toBe(true);
    expect(recordCancelled("Active")).toBe(false);
    expect(recordCancelled(null)).toBe(false);
    expect(recordCancelled("Pending")).toBe("invalid");
  });

  it("reads amounts in integer thousandths (Unite keeps some amounts to three decimals)", () => {
    expect(amountMils(null)).toBe(0);
    expect(amountMils(0.1 + 0.2)).toBe(300);
    expect(amountMils(178799.245)).toBe(178799245);
    expect(amountMils("1,234.56")).toBe(1234560);
    expect(amountMils("abc")).toBe("invalid");
    expect(amountMils(new Date())).toBe("invalid");
  });
});
