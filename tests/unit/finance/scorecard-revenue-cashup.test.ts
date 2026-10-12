import { describe, expect, it } from "vitest";

import { summariseCashup } from "@/lib/finance/cashup";
import { parseRevenue, previousPeriod, revenueCsv, withComparison } from "@/lib/finance/revenue";
import {
  parseScorecardRows,
  scorecardMetrics,
  sortScorecard,
  type ScorecardThresholds,
} from "@/lib/finance/scorecard";

const th: ScorecardThresholds = {
  minClaims: 20,
  denialRateWarn: 0.1,
  denialRateAlert: 0.2,
  daysToPayWarn: 60,
  daysToPayAlert: 90,
};
const row = (over: Partial<Parameters<typeof scorecardMetrics>[0]> = {}) => ({
  group_key: "PAYER-A",
  group_label: null,
  claims: 100,
  denied_claims: 5,
  net: 10_000,
  remitted: 8_000,
  rejected: 500,
  paid_claims: 90,
  avg_days_to_pay: 45,
  p90_days_to_pay: 80,
  ...over,
});

describe("scorecard", () => {
  it("computes the rates", () => {
    const m = scorecardMetrics(row({ denied_claims: 15 }), th);
    expect(m.denialRate).toBeCloseTo(0.15);
    expect(m.amountDenialRate).toBeCloseTo(0.05);
    expect(m.collectionRate).toBeCloseTo(0.8);
  });
  it("colours by the thresholds", () => {
    expect(scorecardMetrics(row({ denied_claims: 5 }), th).denialRag).toBe("green");
    expect(scorecardMetrics(row({ denied_claims: 10 }), th).denialRag).toBe("amber");
    expect(scorecardMetrics(row({ denied_claims: 20 }), th).denialRag).toBe("red");
    expect(scorecardMetrics(row({ avg_days_to_pay: 59.9 }), th).daysRag).toBe("green");
    expect(scorecardMetrics(row({ avg_days_to_pay: 75 }), th).daysRag).toBe("amber");
    expect(scorecardMetrics(row({ avg_days_to_pay: 95 }), th).daysRag).toBe("red");
  });
  it("never colours a small sample", () => {
    const m = scorecardMetrics(row({ claims: 4, denied_claims: 4, paid_claims: 2 }), th);
    expect(m.lowSample).toBe(true);
    expect(m.denialRag).toBe("grey");
    expect(m.daysRag).toBe("grey");
  });
  it("has no rate without any claimed amount, and no days without payments", () => {
    const m = scorecardMetrics(
      row({ net: 0, remitted: 0, rejected: 0, avg_days_to_pay: null, paid_claims: 0 }),
      th,
    );
    expect(m.amountDenialRate).toBeNull();
    expect(m.collectionRate).toBeNull();
    expect(m.daysRag).toBe("grey");
  });
  it("coerces database JSON and sorts", () => {
    const rows = parseScorecardRows([
      {
        group_key: "A",
        claims: "30",
        denied_claims: "3",
        net: "100",
        remitted: "50",
        rejected: "10",
        paid_claims: "20",
        avg_days_to_pay: "40.5",
        p90_days_to_pay: null,
      },
      {
        group_key: "B",
        claims: "50",
        denied_claims: "20",
        net: "100",
        remitted: "50",
        rejected: "10",
        paid_claims: "20",
        avg_days_to_pay: null,
        p90_days_to_pay: null,
      },
    ]).map((r) => scorecardMetrics(r, th));
    expect(sortScorecard(rows, "denial_rate").map((r) => r.group_key)).toEqual(["B", "A"]);
    expect(sortScorecard(rows, "claims")[0].group_key).toBe("B");
    expect(sortScorecard(rows, "days_to_pay")[0].group_key).toBe("A");
    expect(parseScorecardRows(undefined)).toEqual([]);
  });
});

describe("revenue", () => {
  const current = parseRevenue([
    {
      key: "DHA-1",
      label: "Dr Test One",
      net: "600",
      gross: "700",
      discount: "100",
      vat: "30",
      lines: "10",
      invoices: "8",
    },
    {
      key: "DHA-2",
      label: null,
      net: "400",
      gross: "400",
      discount: "0",
      vat: "20",
      lines: "5",
      invoices: "5",
    },
  ]);
  it("computes shares and the change against the previous period", () => {
    const rows = withComparison(current, parseRevenue([{ key: "DHA-1", label: null, net: 300 }]));
    expect(rows[0]).toMatchObject({ share: 0.6, previousNet: 300, changePct: 100 });
    expect(rows[1]).toMatchObject({ share: 0.4, previousNet: 0, changePct: null });
    expect(withComparison(current, null)[0].previousNet).toBeNull();
  });
  it("finds the previous period of equal length", () => {
    expect(previousPeriod("2026-09-01", "2026-09-30")).toEqual({
      from: "2026-08-02",
      to: "2026-08-31",
    });
    expect(previousPeriod("2026-09-30", "2026-09-01")).toBeNull();
    expect(previousPeriod("junk", "2026-09-01")).toBeNull();
  });
  it("writes a CSV that cannot run a formula", () => {
    const evil = withComparison(
      parseRevenue([{ key: "=cmd|' /C calc'!A0", label: "+SUM(1)", net: 1 }]),
      null,
    );
    const csv = revenueCsv(evil, "doctor");
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'+SUM(1)");
    expect(csv.split("\r\n")[0]).toContain("Doctor,Name,Net");
  });
});

describe("cash-up", () => {
  it("shows the variance per mode and in total", () => {
    const s = summariseCashup(
      [
        { mode: "CASH", expected: 100.1, counted: 100.1, reason: null },
        { mode: "CARD", expected: 250, counted: 249.5, reason: null },
      ],
      5,
    );
    expect(s.lines[0].variance).toBe(0);
    expect(s.lines[1].variance).toBe(-0.5);
    expect(s.expectedTotal).toBe(350.1);
    expect(s.countedTotal).toBe(349.6);
    expect(s.varianceTotal).toBe(-0.5);
    expect(s.canSubmit).toBe(true);
  });
  it("needs every mode counted, and a reason beyond the tolerance (the tolerance itself is allowed)", () => {
    const uncounted = summariseCashup(
      [{ mode: "CASH", expected: 10, counted: null, reason: null }],
      5,
    );
    expect(uncounted.canSubmit).toBe(false);
    const edge = summariseCashup([{ mode: "CASH", expected: 100, counted: 95, reason: null }], 5);
    expect(edge.lines[0].needsReason).toBe(false);
    expect(edge.canSubmit).toBe(true);
    const over = summariseCashup(
      [{ mode: "CASH", expected: 100, counted: 94.99, reason: "  " }],
      5,
    );
    expect(over.lines[0].needsReason).toBe(true);
    expect(over.canSubmit).toBe(false);
    expect(
      summariseCashup(
        [{ mode: "CASH", expected: 100, counted: 90, reason: "Float taken to the bank" }],
        5,
      ).canSubmit,
    ).toBe(true);
  });
  it("adds in cents so floats cannot create a phantom variance", () => {
    const s = summariseCashup(
      [{ mode: "CASH", expected: 0.1 + 0.2, counted: 0.3, reason: null }],
      0,
    );
    expect(s.lines[0].variance).toBe(0);
    expect(s.canSubmit).toBe(true);
  });
  it("allows a day with nothing to count", () => {
    expect(summariseCashup([], 5).canSubmit).toBe(true);
  });
});
