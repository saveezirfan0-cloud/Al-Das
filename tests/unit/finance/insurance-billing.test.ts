/**
 * Phase 23D-2: insurance billed vs claimed, the pure rules. Synthetic invoice numbers only (INS-SYN-*).
 */
import { describe, expect, it } from "vitest";

import {
  buildInsuranceBilling,
  classifyInvoice,
  daysBetween,
  difference,
  invoiceKey,
  parseReconInputs,
  reconSettingsSchema,
  type BilledInvoice,
  type ReconSettings,
} from "@/lib/finance/insurance-billing";
import { normalizeInvoiceNumber } from "@/lib/finance/keys";

const S: ReconSettings = { tolerance: 1, graceDays: 7 };
const inv = (o: Partial<BilledInvoice> & { key: string }): BilledInvoice => ({
  invoiceNo: o.key,
  billed: 100,
  rows: 1,
  firstDate: "2026-09-10",
  lastDate: "2026-09-10",
  pairs: 1,
  visiblePairs: [{ branch: "PJ", doctor: "Dr Demo-01" }],
  submitted: null,
  activities: 0,
  payers: [],
  ...o,
});

describe("invoice number rule", () => {
  it("is the Unite invoice key rule: upper case, every whitespace removed", () => {
    expect(invoiceKey).toBe(normalizeInvoiceNumber);
    expect(invoiceKey(" ins-syn 001\t")).toBe("INS-SYN001");
    expect(invoiceKey("ins\nsyn\r\n 002")).toBe("INSSYN002");
    expect(invoiceKey("INS-SYN-003")).toBe("INS-SYN-003");
    expect(invoiceKey(null)).toBe("");
    expect(invoiceKey("   ")).toBe("");
    // case and spacing never make two numbers differ
    expect(invoiceKey("Ins-Syn 004")).toBe(invoiceKey("INS-SYN004"));
  });
});

describe("classification", () => {
  const asOf = "2026-09-20";

  it("an invoice number with more than one branch/doctor is ambiguous, even when Diligence has it", () => {
    expect(classifyInvoice(inv({ key: "A", pairs: 2 }), S, asOf)).toBe("ambiguous");
    expect(
      classifyInvoice(inv({ key: "A", pairs: 3, submitted: 100, activities: 1 }), S, asOf),
    ).toBe("ambiguous");
  });

  it("an invoice Diligence has is matched, whatever the amounts", () => {
    expect(classifyInvoice(inv({ key: "M", submitted: 0, activities: 2 }), S, asOf)).toBe(
      "matched",
    );
    expect(
      classifyInvoice(inv({ key: "M", billed: 0, submitted: 50, activities: 1 }), S, asOf),
    ).toBe("matched");
  });

  it("grace days: at risk only when MORE than the grace days have passed since the latest report date", () => {
    // 2026-09-13 -> 2026-09-20 is 7 days: still inside
    expect(classifyInvoice(inv({ key: "G", lastDate: "2026-09-13" }), S, asOf)).toBe("awaiting");
    expect(classifyInvoice(inv({ key: "G", lastDate: "2026-09-12" }), S, asOf)).toBe(
      "billed_not_submitted",
    );
    // the latest of the invoice's report dates counts
    expect(
      classifyInvoice(inv({ key: "G", firstDate: "2026-09-01", lastDate: "2026-09-15" }), S, asOf),
    ).toBe("awaiting");
    // grace 0: one day later is at risk, the same day is not
    const zero = { ...S, graceDays: 0 };
    expect(classifyInvoice(inv({ key: "G", lastDate: asOf }), zero, asOf)).toBe("awaiting");
    expect(classifyInvoice(inv({ key: "G", lastDate: "2026-09-19" }), zero, asOf)).toBe(
      "billed_not_submitted",
    );
  });

  it("nothing billed and nothing submitted is nothing to claim", () => {
    expect(classifyInvoice(inv({ key: "Z", billed: 0, lastDate: "2026-01-01" }), S, asOf)).toBe(
      "nothing_to_claim",
    );
    expect(
      classifyInvoice(inv({ key: "Z", billed: 0.0004, lastDate: "2026-01-01" }), S, asOf),
    ).toBe("nothing_to_claim");
  });

  it("tolerance: flagged only when the difference is MORE than the tolerance, either way, to the fil", () => {
    expect(difference(100, 99, S)).toEqual({ difference: 1, flagged: false });
    expect(difference(100, 101, S)).toEqual({ difference: -1, flagged: false });
    expect(difference(100, 98.999, S)).toEqual({ difference: 1.001, flagged: true });
    expect(difference(100.3, 101.301, S)).toEqual({ difference: -1.001, flagged: true });
    // float noise never moves the edge: 0.1 + 0.2 style sums
    expect(difference(0.1 + 0.2 + 1, 0.3, S).flagged).toBe(false);
    expect(difference(250, 250, { ...S, tolerance: 0 })).toEqual({ difference: 0, flagged: false });
    expect(difference(250, 249.999, { ...S, tolerance: 0 }).flagged).toBe(true);
  });

  it("days between two dates", () => {
    expect(daysBetween("2026-09-10", "2026-09-20")).toBe(10);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(daysBetween("2026-09-20", "2026-09-20")).toBe(0);
  });
});

describe("the report", () => {
  const raw = {
    month: "2026-09-01",
    branch: null,
    unreported_shown: true,
    coverage: [{ from: "2026-09-01", to: "2026-09-30" }],
    settings: { tolerance: 1.0, grace_days: 7 },
    summary: {
      billed: 1650.5,
      billed_rows: 7,
      no_invoice_no_rows: 1,
      no_invoice_no_amount: 50,
      cancelled_rows: 1,
      cancelled_amount: 75,
      submitted_no_invoice_no_activities: 2,
      submitted_no_invoice_no_amount: 30,
    },
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
        submitted: 300,
        activities: 2,
        payers: ["SYN-P1"],
      },
      {
        key: "INS-SYN-002",
        invoice_no: "ins-syn 002",
        billed: 200.5,
        rows: 2,
        first_date: "2026-09-03",
        last_date: "2026-09-04",
        pairs: 1,
        visible_pairs: [{ branch: "GM", doctor: "Dr Demo-02" }],
        submitted: 190,
        activities: 1,
        payers: [],
      },
      {
        key: "INS-SYN-003",
        invoice_no: "INS-SYN-003",
        billed: 400,
        rows: 1,
        first_date: "2026-09-01",
        last_date: "2026-09-01",
        pairs: 1,
        visible_pairs: [{ branch: null, doctor: "Dr Demo-03" }],
        submitted: null,
        activities: 0,
        payers: [],
      },
      {
        key: "INS-SYN-004",
        invoice_no: "INS-SYN-004",
        billed: 250,
        rows: 1,
        first_date: "2026-09-18",
        last_date: "2026-09-18",
        pairs: 1,
        visible_pairs: [{ branch: "PJ", doctor: "Dr Demo-01" }],
        submitted: null,
        activities: 0,
        payers: [],
      },
      {
        key: "INS-SYN-005",
        invoice_no: "INS-SYN-005",
        billed: 400,
        rows: 2,
        first_date: "2026-09-05",
        last_date: "2026-09-05",
        pairs: 2,
        visible_pairs: [
          { branch: "PJ", doctor: "Dr Demo-01" },
          { branch: "PJ", doctor: "Dr Demo-04" },
        ],
        submitted: 400,
        activities: 1,
        payers: [],
      },
      {
        key: "INS-SYN-006",
        invoice_no: "INS-SYN-006",
        billed: 0,
        rows: 1,
        first_date: "2026-09-02",
        last_date: "2026-09-02",
        pairs: 1,
        visible_pairs: [],
        submitted: null,
        activities: 0,
        payers: [],
      },
      {
        key: "INS-SYN-007",
        invoice_no: "INS-SYN-007",
        billed: 50,
        rows: 1,
        first_date: "2026-09-06",
        last_date: "2026-09-06",
        pairs: 1,
        visible_pairs: [],
        submitted: 50.5,
        activities: 1,
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
      {
        key: "INS-SYN-102",
        invoice_no: "INS-SYN-102",
        submitted: 120,
        activities: 2,
        first_date: "2026-09-10",
        payers: [],
        report_month: null,
        cancelled_in_report: true,
      },
      {
        key: "INS-SYN-103",
        invoice_no: "INS-SYN-103",
        submitted: 60,
        activities: 1,
        first_date: "2026-09-11",
        payers: [],
        report_month: null,
        cancelled_in_report: false,
      },
    ],
  };

  it("sorts every invoice into one bucket and sums in fils", () => {
    const r = buildInsuranceBilling(parseReconInputs(raw), "2026-09-20");
    expect(r.matched.map((m) => [m.invoiceNo, m.difference, m.flagged])).toEqual([
      ["ins-syn 002", 10.5, true],
      ["INS-SYN-007", -0.5, false],
      ["INS-SYN-001", 0, false],
    ]);
    expect(r.billedNotSubmitted.map((x) => [x.invoiceNo, x.ageDays])).toEqual([
      ["INS-SYN-003", 19],
    ]);
    expect(r.awaiting.map((x) => [x.invoiceNo, x.ageDays])).toEqual([["INS-SYN-004", 2]]);
    expect(r.ambiguous.map((x) => x.invoiceNo)).toEqual(["INS-SYN-005"]);
    expect(r.unreported.map((x) => [x.invoiceNo, x.note])).toEqual([
      ["INS-SYN-102", "cancelled"],
      ["INS-SYN-101", "other_month"],
      ["INS-SYN-103", "not_in_report"],
    ]);
    expect(r.summary).toMatchObject({
      billed: 1650.5,
      submitted: 300 + 190 + 50.5 + 400,
      atRisk: 400,
      atRiskCount: 1,
      awaitingAmount: 250,
      awaitingCount: 1,
      matchedCount: 3,
      flaggedCount: 1,
      flaggedDifference: 10.5,
      ambiguousCount: 1,
      unreportedCount: 3,
      unreportedAmount: 260,
      noInvoiceNoRows: 1,
      cancelledAmount: 75,
      submittedNoInvoiceNoActivities: 2,
    });
    expect(r.summary.matchedPct).toBeCloseTo((300 + 200.5 + 50) / 1650.5, 12);
    expect(r.coverage.full).toBe(true);
    expect(r.hasData).toBe(true);
  });

  it("tolerance and grace days come from the settings", () => {
    const r = buildInsuranceBilling(
      parseReconInputs({ ...raw, settings: { tolerance: 20, grace_days: 30 } }),
      "2026-09-20",
    );
    expect(r.matched.filter((m) => m.flagged)).toEqual([]);
    expect(r.billedNotSubmitted).toEqual([]);
    expect(r.awaiting.map((x) => x.invoiceNo)).toEqual(["INS-SYN-003", "INS-SYN-004"]);
  });

  it("drops the unreported list and the no-number activities when the SQL did not show them", () => {
    const r = buildInsuranceBilling(
      parseReconInputs({ ...raw, unreported_shown: false }),
      "2026-09-20",
    );
    expect(r.unreported).toEqual([]);
    expect(r.summary.submittedNoInvoiceNoActivities).toBe(0);
    expect(r.summary.submittedNoInvoiceNoAmount).toBe(0);
  });

  it("an empty month has no data and no matched %", () => {
    const r = buildInsuranceBilling(parseReconInputs({ month: "2026-01-01" }), "2026-09-20");
    expect(r.hasData).toBe(false);
    expect(r.summary.matchedPct).toBeNull();
    expect(r.settings).toEqual({ tolerance: 1, graceDays: 7 });
    expect(r.coverage.full).toBe(false);
  });

  it("reads a tolerance of 0 and grace days of 0 as given (not as the defaults)", () => {
    const p = parseReconInputs({ settings: { tolerance: 0, grace_days: 0 } });
    expect(p.settings).toEqual({ tolerance: 0, graceDays: 0 });
  });
});

describe("settings", () => {
  it("accepts 0 to 100,000 AED with two decimals and 0 to 365 whole days", () => {
    expect(
      reconSettingsSchema.safeParse({ ins_recon_tolerance: "1.00", ins_recon_grace_days: "7" })
        .success,
    ).toBe(true);
    expect(
      reconSettingsSchema.safeParse({ ins_recon_tolerance: "0", ins_recon_grace_days: "0" })
        .success,
    ).toBe(true);
    for (const bad of [
      { ins_recon_tolerance: "-1", ins_recon_grace_days: "7" },
      { ins_recon_tolerance: "1.005", ins_recon_grace_days: "7" },
      { ins_recon_tolerance: "100001", ins_recon_grace_days: "7" },
      { ins_recon_tolerance: "1", ins_recon_grace_days: "7.5" },
      { ins_recon_tolerance: "1", ins_recon_grace_days: "366" },
      { ins_recon_tolerance: "1", ins_recon_grace_days: "-1" },
      { ins_recon_tolerance: "x", ins_recon_grace_days: "7" },
    ])
      expect(reconSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
