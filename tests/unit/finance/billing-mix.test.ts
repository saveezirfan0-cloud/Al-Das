import { describe, expect, it } from "vitest";

import {
  billingMixCsv,
  categoryOrder,
  describeMix,
  parseBillingMix,
  parseTrend,
  monthStartBefore,
  periodLabel,
  readAnalyticsFilters,
  share,
  trendCsv,
  trendTotals,
} from "@/lib/finance/billing-mix";

import fixture from "./fixtures/billing-mix.synthetic.json";

const mix = parseBillingMix(fixture.mix);
const trend = parseTrend(fixture.trend);

describe("billing mix (slice 20K)", () => {
  it("parses the SQL shape, including the clinic row and a row without a doctor", () => {
    expect(mix.doctorBasis).toBeNull();
    expect(mix.clinic).toMatchObject({ net: 10000, invoices: 40, lines: 100, patients: 30 });
    expect(mix.rows.map((r) => r.doctorId)).toEqual(["SYN-D1", "SYN-D2", null]);
    expect(mix.rows[1].payer.other).toEqual({ net: 500, invoices: 1 });
    expect(mix.rows[2].categories.Radiology).toBeUndefined();
  });

  it("is safe on empty or malformed input", () => {
    expect(parseBillingMix(null)).toEqual({ doctorBasis: null, clinic: null, rows: [] });
    const odd = parseBillingMix({
      doctor_basis: "nonsense",
      rows: [{ net: "abc", categories: [1] }],
    });
    expect(odd.doctorBasis).toBeNull();
    expect(odd.rows[0]).toMatchObject({
      net: 0,
      categories: {},
      payer: { insurance: { net: 0, invoices: 0 } },
    });
    expect(parseBillingMix({ doctor_basis: "performing" }).doctorBasis).toBe("performing");
  });

  it("orders categories by the clinic's revenue with Unmapped last", () => {
    expect(categoryOrder(mix)).toEqual(["Consultation", "Lab", "Radiology", "Unmapped"]);
  });

  it("works out revenue per patient, lines per invoice and the insurance share", () => {
    const { clinic, rows } = describeMix(mix);
    expect(rows[0].arpp).toBe(300);
    expect(rows[1].arpp).toBeCloseTo(388.89, 2);
    expect(clinic!.arpp).toBeCloseTo(333.33, 2);
    expect(rows[0].linesPerInvoice).toBe(2.8);
    expect(clinic!.linesPerInvoice).toBe(2.5);
    expect(rows[0].insuranceShare).toBe(0.75);
    expect(rows[1].insuranceShare).toBeCloseTo(0.3429, 4);
    expect(clinic!.insuranceShare).toBe(0.6);
  });

  it("compares each doctor's category shares with the clinic's, in percentage points", () => {
    const { clinic, rows } = describeMix(mix);
    expect(rows[0].categoryShares).toEqual({
      Consultation: 0.25,
      Lab: 0.4,
      Radiology: 0.25,
      Unmapped: 0.1,
    });
    expect(rows[0].difference).toEqual({ Consultation: -15, Lab: 10, Radiology: 5, Unmapped: 0 });
    expect(rows[0].largest).toEqual({ category: "Consultation", points: -15 });
    expect(rows[1].difference).toEqual({
      Consultation: 25.7,
      Lab: -15.7,
      Radiology: -5.7,
      Unmapped: -4.3,
    });
    expect(rows[1].largest).toEqual({ category: "Consultation", points: 25.7 });
    // a category the doctor never billed is a 0 share, not missing
    expect(rows[2].categoryShares.Radiology).toBe(0);
    expect(rows[2].difference.Radiology).toBe(-20);
    // the clinic against itself differs by nothing
    expect(Object.values(clinic!.difference).every((d) => d === 0)).toBe(true);
    expect(clinic!.largest).toBeNull();
    // shares of the clinic add up to 100 %
    const total = Object.values(clinic!.categoryShares).reduce((a, s) => a! + s!, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it("never divides by zero: no revenue or no patients gives null, not 0 or Infinity", () => {
    expect(share(5, 0)).toBeNull();
    expect(share(5, -10)).toBeNull();
    const zero = parseBillingMix({
      clinic: fixture.mix.clinic,
      rows: [
        { doctor_id: "SYN-D9", net: 0, invoices: 0, lines: 0, patients: 0, categories: { Lab: 0 } },
      ],
    });
    const r = describeMix(zero).rows[0];
    expect(r.arpp).toBeNull();
    expect(r.linesPerInvoice).toBeNull();
    expect(r.insuranceShare).toBeNull();
    expect(r.categoryShares.Lab).toBeNull();
    expect(r.difference.Lab).toBeNull();
    expect(r.largest).toBeNull();
    // without a clinic row there is nothing to compare with
    const alone = describeMix({ doctorBasis: null, clinic: null, rows: mix.rows });
    expect(alone.rows[0].difference.Lab).toBeNull();
    expect(alone.rows[0].categoryShares.Lab).toBe(0.4);
  });

  it("writes a CSV with one row per doctor, the clinic last, and no formula cells", () => {
    const csv = billingMixCsv(mix);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("Consultation vs clinic (pts)");
    expect(
      lines[1].startsWith("SYN-D1,Dr Synthetic Alpha,Family Medicine,6000.00,25,20,300.00,2.80,"),
    ).toBe(true);
    expect(lines[1]).toContain(",75.0,1500.00,25.0,-15.0,");
    expect(lines[3].startsWith(",No doctor,,500.00,")).toBe(true);
    expect(lines[4].startsWith("ALL,All doctors,,10000.00,40,30,")).toBe(true);
    const hostile = billingMixCsv({
      doctorBasis: null,
      clinic: null,
      rows: [{ ...mix.rows[0], doctorName: '=HYPERLINK("x")' }],
    });
    expect(hostile).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe("seasonality (slice 20K)", () => {
  it("parses periods and only compares with last year when the records reach back that far", () => {
    expect(trend.grain).toBe("month");
    expect(trend.historyFrom).toBe("2025-08-20");
    expect(trend.rows[0]).toMatchObject({
      period: "2026-08-01",
      from: "2026-08-15",
      net: 20000,
      lastYear: null,
      changePct: null,
    });
    expect(trend.rows[1].lastYear).toEqual({ net: 40000, invoices: 100, patients: 85 });
    expect(trend.rows[1].changePct).toBe(10);
    expect(trend.rows[2].changePct).toBe(-25);
  });

  it("treats a zero last year as no comparison rather than an infinite change", () => {
    const t = parseTrend({
      grain: "week",
      rows: [{ period: "2026-10-05", net: 100, ly_net: 0, ly_covered: true }],
    });
    expect(t.grain).toBe("week");
    expect(t.rows[0].lastYear).toEqual({ net: 0, invoices: 0, patients: 0 });
    expect(t.rows[0].changePct).toBeNull();
    expect(parseTrend(undefined)).toEqual({ grain: "month", historyFrom: null, rows: [] });
  });

  it("totals the range, and compares the totals only when every period has last year's figures", () => {
    expect(trendTotals(trend.rows)).toEqual({
      current: { net: 79000, invoices: 200 },
      lastYear: null,
      changePct: null,
    });
    expect(trendTotals(trend.rows.slice(1))).toEqual({
      current: { net: 59000, invoices: 150 },
      lastYear: { net: 60000, invoices: 152 },
      changePct: -1.7,
    });
    expect(trendTotals([])).toEqual({
      current: { net: 0, invoices: 0 },
      lastYear: null,
      changePct: null,
    });
  });

  it("labels months and weeks", () => {
    expect(periodLabel("month", "2026-10-01")).toBe("Oct 2026");
    expect(periodLabel("week", "2026-10-05")).toBe("w/c 5 Oct 2026");
    expect(periodLabel("week", "nonsense")).toBe("nonsense");
  });

  it("writes a CSV with blanks where last year is not on record", () => {
    const lines = trendCsv(trend).trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "Period,From,To,Net,Invoices,Patients,Last year net,Last year invoices,Last year patients,Change %",
    );
    expect(lines[1]).toBe("Aug 2026,2026-08-15,2026-08-31,20000.00,50,40,,,,");
    expect(lines[3]).toBe("Oct 2026,2026-10-01,2026-10-12,15000.00,40,35,20000.00,52,44,-25");
  });
});

describe("analytics filters (slice 20K)", () => {
  const read = (q: Record<string, string>, today = "2026-10-13") =>
    readAnalyticsFilters((k) => q[k], today);

  it("defaults to the twelve calendar months up to today, by month, all branches", () => {
    expect(read({})).toEqual({
      from: "2025-11-01",
      to: "2026-10-13",
      branch: null,
      grain: "month",
    });
    expect(monthStartBefore("2026-01-31", 1)).toBe("2025-12-01");
    expect(monthStartBefore("2026-12-01", 11)).toBe("2026-01-01");
  });

  it("swaps a reversed range, ignores bad dates and shortens a range over the limit", () => {
    expect(read({ from: "2026-09-30", to: "2026-09-01" })).toMatchObject({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(read({ from: "2026-02-30", to: "nope" })).toMatchObject({
      from: "2025-11-01",
      to: "2026-10-13",
    });
    expect(read({ from: "2020-01-01", to: "2026-10-13" }).from).toBe("2023-10-09");
  });

  it("cleans the branch code and accepts only week or month", () => {
    expect(read({ branch: "p'; drop", grain: "week" })).toMatchObject({
      branch: "PDRO",
      grain: "week",
    });
    expect(read({ grain: "day" }).grain).toBe("month");
  });
});
