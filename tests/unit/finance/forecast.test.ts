import { describe, expect, it } from "vitest";

import {
  buildForecast,
  expectedPayDays,
  parseHistory,
  parseOutstanding,
  type ForecastSettings,
  type HistoryRow,
  type OutstandingRow,
} from "@/lib/finance/forecast";

import fixture from "./fixtures/phase18-forecast.synthetic.json";

const settings = fixture.settings as ForecastSettings;

describe("buildForecast", () => {
  it("spreads a new receivable over the default payment curve, weighted by the default collection rate", () => {
    const f = buildForecast(
      fixture.outstanding as OutstandingRow[],
      fixture.history as HistoryRow[],
      fixture.today,
      settings,
    );
    expect(f.weekStarts[0]).toBe("2026-10-19");
    expect(f.weeks).toHaveLength(13);
    for (const [idx, amount] of Object.entries(fixture.expectedWeeks))
      expect(f.weeks[Number(idx)]).toBe(amount);
    expect(f.beyondHorizon).toBe(fixture.expectedBeyondHorizon);
    expect(f.expectedTotal).toBe(fixture.expectedTotal);
    expect(f.totalOutstanding).toBe(1000);
    expect(f.notExpected).toBe(100);
    expect(f.payers[0]).toMatchObject({ payerId: "PAYER-NEW", assumed: true, collectionRate: 0.9 });
  });

  it("uses a payer's own history once there is enough of it, and a lower collection rate collects less", () => {
    const f = buildForecast(
      fixture.known.outstanding as OutstandingRow[],
      fixture.known.history as HistoryRow[],
      fixture.today,
      settings,
    );
    expect(f.payers[0]).toMatchObject({
      payerId: "PAYER-OLD",
      assumed: false,
      collectionRate: 0.5,
    });
    expect(f.expectedTotal).toBe(1000); // 2,000 x 0.5
    // a fast payer (p50 = 14 days) lands its money in the first weeks
    expect(f.weeks.slice(0, 6).reduce((a, w) => a + w, 0)).toBeGreaterThan(
      f.weeks.slice(6).reduce((a, w) => a + w, 0),
    );
  });

  it("does not trust a payer with fewer paid claims than minHistory", () => {
    const thin: HistoryRow[] = [
      {
        payer_id: "PAYER-OLD",
        paid_claims: 5,
        p25: 1,
        p50: 2,
        p75: 3,
        p90: 4,
        mature_claims: 5,
        collection_rate: 1,
      },
    ];
    const f = buildForecast(
      fixture.known.outstanding as OutstandingRow[],
      thin,
      fixture.today,
      settings,
    );
    expect(f.payers[0]).toMatchObject({ assumed: true, collectionRate: 0.9 });
  });

  it("puts a claim older than every payment slice into the tail window from today, never into the past", () => {
    const old: OutstandingRow[] = [
      { payer_id: "PAYER-NEW", week_start: "2026-01-05", claims: 1, outstanding: 500 },
    ];
    const f = buildForecast(old, [], fixture.today, settings);
    expect(f.expectedTotal).toBe(450);
    expect(f.weeks[0]).toBe(0); // not this week
    expect(f.weeks[2]).toBe(450); // two weeks out: half the four-week tail
  });

  it("conserves money: expected + not expected equals outstanding, for any mix", () => {
    const rows: OutstandingRow[] = [
      { payer_id: "A", week_start: "2026-10-12", claims: 3, outstanding: 333.33 },
      { payer_id: "A", week_start: "2026-08-03", claims: 2, outstanding: 777.77 },
      { payer_id: "B", week_start: "2026-05-04", claims: 9, outstanding: 1234.56 },
      { payer_id: "B", week_start: "2026-10-05", claims: 1, outstanding: 0 },
    ];
    const hist: HistoryRow[] = [
      {
        payer_id: "A",
        paid_claims: 50,
        p25: 10,
        p50: 20,
        p75: 40,
        p90: 80,
        mature_claims: 60,
        collection_rate: 0.8,
      },
    ];
    const f = buildForecast(rows, hist, fixture.today, settings);
    const byPayer = f.payers.reduce((a, p) => a + p.expected, 0);
    expect(Math.abs(byPayer - f.expectedTotal)).toBeLessThan(0.05);
    expect(f.cumulative.at(-1)).toBeCloseTo(
      f.weeks.reduce((a, w) => a + w, 0),
      1,
    );
    expect(f.totalOutstanding).toBeCloseTo(333.33 + 777.77 + 1234.56, 2);
    expect(f.weeks.every((w) => w >= 0)).toBe(true);
  });

  it("handles no receivables at all", () => {
    const f = buildForecast([], [], fixture.today, settings);
    expect(f.expectedTotal).toBe(0);
    expect(f.weeks.every((w) => w === 0)).toBe(true);
    expect(f.payers).toEqual([]);
  });

  it("rejects a bad date instead of guessing", () => {
    expect(() => buildForecast([], [], "not-a-date", settings)).toThrow(RangeError);
  });
});

describe("expectedPayDays", () => {
  const slices = [
    { lo: 0, hi: 30, mass: 0.25 },
    { lo: 30, hi: 60, mass: 0.25 },
    { lo: 60, hi: 90, mass: 0.25 },
    { lo: 90, hi: 120, mass: 0.15 },
    { lo: 120, hi: 148, mass: 0.1 },
  ];
  it("re-weights the slices that are left and always sums to 1", () => {
    for (const age of [0, 10, 45, 100, 130, 200]) {
      const parts = expectedPayDays(age, slices, 28);
      expect(parts.reduce((a, [, w]) => a + w, 0)).toBeCloseTo(1, 10);
      expect(parts.every(([d]) => d >= age)).toBe(true);
    }
  });
});

describe("parsers", () => {
  it("coerce database JSON", () => {
    expect(
      parseOutstanding([
        { payer_id: "A", week_start: "2026-10-12", claims: "3", outstanding: "10.5" },
      ])[0].outstanding,
    ).toBe(10.5);
    expect(
      parseHistory([{ payer_id: "A", paid_claims: "3", p25: null, p50: "2" }])[0],
    ).toMatchObject({ p25: null, p50: 2 });
    expect(parseOutstanding(null)).toEqual([]);
  });
});
