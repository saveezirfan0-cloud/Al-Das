import { describe, expect, it } from "vitest";

import { aed, ago, delta, deltaLabel, money, moneyCompact } from "@/lib/finance/format";
import {
  doneCount,
  isReady,
  nextStep,
  readinessSteps,
  type ReadinessInput,
} from "@/lib/finance/readiness";
import {
  activeRange,
  monthSpan,
  monthlySeries,
  previousRange,
  rangeFor,
  splitPeriods,
  type SummaryRow,
} from "@/lib/finance/summary";
import {
  ageingTotals,
  claimInRange,
  claimsByPayer,
  monthEnd,
  topDenials,
} from "@/lib/finance/summary-extras";

const NOW = new Date("2026-10-10T12:00:00Z");

describe("format", () => {
  it("formats money and treats blanks as a dash", () => {
    expect(money(1234.5)).toBe("1,234.50");
    expect(money("99")).toBe("99.00");
    expect(money(null)).toBe("—");
    expect(money(undefined)).toBe("—");
    expect(money(Number.NaN)).toBe("—");
    expect(aed(null)).toBe("—");
    expect(aed(10)).toContain("10.00");
  });

  it("compacts large amounts only", () => {
    expect(moneyCompact(980)).toBe("980.00");
    expect(moneyCompact(34_500)).toBe("34.5K");
    expect(moneyCompact(1_250_000)).toBe("1.25M");
    expect(moneyCompact(null)).toBe("—");
  });

  it("delta never divides by zero and keeps the sign", () => {
    expect(delta(110, 100)).toEqual({ pct: 10, direction: "up" });
    expect(delta(90, 100)).toEqual({ pct: -10, direction: "down" });
    expect(delta(100, 100)).toEqual({ pct: 0, direction: "flat" });
    expect(delta(50, 0)).toEqual({ pct: null, direction: "none" });
    expect(delta(50, null)).toEqual({ pct: null, direction: "none" });
    expect(delta(50, -100).pct).toBe(150); // relative to |previous|
    expect(deltaLabel(delta(50, 0))).toMatch(/no earlier period/);
    expect(deltaLabel(delta(110, 100))).toBe("+10% vs earlier period");
  });

  it("ago is relative and safe on bad input", () => {
    expect(ago(null)).toBe("never");
    expect(ago("not a date", NOW)).toBe("never");
    expect(ago("2026-10-10T11:59:50Z", NOW)).toBe("just now");
    expect(ago("2026-10-10T11:15:00Z", NOW)).toBe("45 min ago");
    expect(ago("2026-10-10T09:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-10-05T12:00:00Z", NOW)).toBe("5 days ago");
  });
});

describe("readiness", () => {
  const empty: ReadinessInput = {
    credentialsConfigured: false,
    captureEnabled: false,
    batchCount: 0,
    invoiceCount: 0,
    claimCount: 0,
    branchesMapped: 0,
    activeRules: 0,
    lastImportAt: null,
  };
  const state = (i: ReadinessInput) =>
    Object.fromEntries(readinessSteps(i).map((s) => [s.key, s.state]));

  it("a fresh org has everything to do, and later steps are blocked", () => {
    expect(state(empty)).toEqual({
      credentials: "todo",
      branches: "todo",
      capture: "blocked",
      invoices: "blocked",
      diligence: "todo",
      rules: "todo",
    });
    expect(nextStep(readinessSteps(empty))?.key).toBe("credentials");
    expect(isReady(readinessSteps(empty))).toBe(false);
  });

  it("credentials unlock capture; capture unlocks invoices", () => {
    expect(state({ ...empty, credentialsConfigured: true }).capture).toBe("todo");
    const on = state({ ...empty, credentialsConfigured: true, captureEnabled: true });
    expect(on.capture).toBe("done");
    expect(on.invoices).toBe("todo");
  });

  it("everything done is ready", () => {
    const steps = readinessSteps({
      credentialsConfigured: true,
      captureEnabled: true,
      batchCount: 3,
      invoiceCount: 120,
      claimCount: 400,
      branchesMapped: 3,
      activeRules: 10,
      lastImportAt: "2026-10-01T00:00:00Z",
    });
    expect(isReady(steps)).toBe(true);
    expect(doneCount(steps)).toBe(steps.length);
    expect(nextStep(steps)).toBeNull();
  });

  it("a claim count without a committed import is not 'done'", () => {
    expect(state({ ...empty, claimCount: 5, lastImportAt: null }).diligence).toBe("todo");
  });

  it("every step names a permission and a portal path", () => {
    for (const s of readinessSteps(empty)) {
      expect(s.href.startsWith("/finance/")).toBe(true);
      expect(s.perm.startsWith("finance.")).toBe(true);
    }
  });
});

describe("ranges", () => {
  it("presets resolve against 'now'", () => {
    expect(rangeFor("this_month", NOW)).toEqual({ from: "2026-10", to: "2026-10" });
    expect(rangeFor("last_month", NOW)).toEqual({ from: "2026-09", to: "2026-09" });
    expect(rangeFor("last_3", NOW)).toEqual({ from: "2026-08", to: "2026-10" });
    expect(rangeFor("ytd", NOW)).toEqual({ from: "2026-01", to: "2026-10" });
    expect(rangeFor("last_12", NOW)).toEqual({ from: "2025-11", to: "2026-10" });
    expect(activeRange("2026-08", "2026-10", NOW)).toBe("last_3");
    expect(activeRange("2024-01", "2024-02", NOW)).toBeNull();
  });

  it("January: last month crosses the year boundary", () => {
    const jan = new Date("2027-01-15T00:00:00Z");
    expect(rangeFor("last_month", jan)).toEqual({ from: "2026-12", to: "2026-12" });
    expect(rangeFor("ytd", jan)).toEqual({ from: "2027-01", to: "2027-01" });
  });

  it("monthSpan counts inclusively and never goes negative", () => {
    expect(monthSpan("2026-10", "2026-10")).toBe(1);
    expect(monthSpan("2025-11", "2026-10")).toBe(12);
    expect(monthSpan("2026-10", "2026-01")).toBe(0);
  });

  it("previousRange is the equal-length range directly before", () => {
    expect(previousRange("2026-10", "2026-10")).toEqual({ from: "2026-09", to: "2026-09" });
    expect(previousRange("2026-08", "2026-10")).toEqual({ from: "2026-05", to: "2026-07" });
    expect(previousRange("2026-01", "2026-03")).toEqual({ from: "2025-10", to: "2025-12" });
  });

  const row = (month: string, branch: string, generated: number): SummaryRow => ({
    month: `${month}-01`,
    branch_code: branch,
    generated,
    claimed: null,
    remitted: null,
    rejected: null,
    outstanding: null,
    self_pay_collected: null,
  });

  it("splits rows into current and previous periods", () => {
    const rows = [row("2026-10", "P", 5), row("2026-09", "P", 3), row("2026-08", "M", 2)];
    const { current, previous } = splitPeriods(rows, "2026-09");
    expect(current.map((r) => r.month)).toEqual(["2026-10-01", "2026-09-01"]);
    expect(previous.map((r) => r.month)).toEqual(["2026-08-01"]);
  });

  it("monthlySeries adds branches up per month, oldest first", () => {
    const s = monthlySeries([
      row("2026-10", "P", 5),
      row("2026-10", "M", 1),
      row("2026-09", "P", 3),
    ]);
    expect(s.map((x) => [x.month, x.generated])).toEqual([
      ["2026-09", 3],
      ["2026-10", 6],
    ]);
  });
});

describe("summary extras", () => {
  it("ageing always returns the four buckets, in order", () => {
    const a = ageingTotals([
      { bucket: "90+", claim_activities: 2, outstanding: 50.505 },
      { bucket: "0-30", claim_activities: 1, outstanding: 10 },
      { bucket: "0-30", claim_activities: 1, outstanding: 5 },
    ]);
    expect(a.map((x) => x.bucket)).toEqual(["0-30", "31-60", "61-90", "90+"]);
    expect(a[0]).toEqual({ bucket: "0-30", claimActivities: 2, outstanding: 15 });
    expect(a[1].outstanding).toBe(0);
    expect(a[3].outstanding).toBe(50.51);
  });

  it("claimInRange uses year+month and excludes rows without a month", () => {
    const r = (y: number | null, m: number | null) =>
      ({ claim_year: y, claim_month: m }) as Parameters<typeof claimInRange>[0];
    expect(claimInRange(r(2026, 9), "2026-08", "2026-10")).toBe(true);
    expect(claimInRange(r(2026, 11), "2026-08", "2026-10")).toBe(false);
    expect(claimInRange(r(2025, 12), "2025-11", "2026-01")).toBe(true);
    expect(claimInRange(r(null, 9), "2026-08", "2026-10")).toBe(false);
  });

  it("claimsByPayer names payers, sums, and avoids a 0/0 rate", () => {
    const names = new Map([["P1", "Payer One"]]);
    const base = { claim_year: 2026, claim_month: 9, resubmitted: 0, rejected_amount: 0 };
    const out = claimsByPayer(
      [
        {
          ...base,
          payer_id: "P1",
          submitted: 10,
          accepted: 7,
          rejected: 2,
          pending: 1,
          net: 1000,
          remitted: 700,
        },
        {
          ...base,
          payer_id: "P1",
          submitted: 5,
          accepted: 5,
          rejected: 0,
          pending: 0,
          net: 500,
          remitted: 500,
        },
        {
          ...base,
          payer_id: null,
          submitted: 0,
          accepted: 0,
          rejected: 0,
          pending: 0,
          net: 10,
          remitted: 0,
        },
      ],
      names,
    );
    expect(out[0]).toMatchObject({
      payer: "Payer One",
      submitted: 15,
      net: 1500,
      rejectionRate: 13.3,
    });
    expect(out[1]).toMatchObject({ payer: "Unknown payer", rejectionRate: null });
  });

  it("topDenials merges by code, ranks by amount and limits", () => {
    const d = (code: string | null, type: string | null, n: number, amt: number) => ({
      last_denial_code: code,
      denial_type: type,
      claim_activities: n,
      rejected_amount: amt,
    });
    const out = topDenials(
      [
        d("MNEC-003", "Clinical", 1, 100),
        d("MNEC-003", "Clinical", 2, 50),
        d(null, null, 1, 500),
        d("X", null, 1, 1),
      ],
      2,
    );
    expect(out).toEqual([
      { label: "No denial code", claimActivities: 1, amount: 500 },
      { label: "MNEC-003 · Clinical", claimActivities: 3, amount: 150 },
    ]);
  });

  it("monthEnd handles leap years and December", () => {
    expect(monthEnd("2028-02")).toBe("2028-02-29");
    expect(monthEnd("2026-02")).toBe("2026-02-28");
    expect(monthEnd("2026-12")).toBe("2026-12-31");
  });
});
