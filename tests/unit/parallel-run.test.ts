import { describe, expect, it } from "vitest";

import {
  MAX_MAKE_KEYS_PER_UPLOAD,
  normaliseDate,
  parseMakeKeys,
  signOffBlockers,
  type DayDiff,
  type ScenarioFacts,
} from "@/lib/cutover/parallel-run";

describe("normaliseDate", () => {
  it("reads ISO and day-first dates and rejects impossible ones", () => {
    expect(normaliseDate("2026-10-12")).toBe("2026-10-12");
    expect(normaliseDate("12/10/2026")).toBe("2026-10-12");
    expect(normaliseDate("2.3.2026")).toBe("2026-03-02");
    expect(normaliseDate(' "05-11-2026" ')).toBe("2026-11-05");
    expect(normaliseDate("31/02/2026")).toBeNull();
    expect(normaliseDate("2026-13-01")).toBeNull();
    expect(normaliseDate("yesterday")).toBeNull();
  });
});

describe("parseMakeKeys", () => {
  it("one id per line uses the default date; duplicates collapse", () => {
    const r = parseMakeKeys("A100\nA101\n\nA100\n", "2026-10-12");
    expect(r.rows).toEqual([
      { date: "2026-10-12", key: "A100" },
      { date: "2026-10-12", key: "A101" },
    ]);
    expect(r.rejected).toBe(0);
  });

  it("key,date lines carry their own date, in either format", () => {
    const r = parseMakeKeys("A1,12/10/2026\nA2,2026-10-13\nA1,12/10/2026", null);
    expect(r.rows).toEqual([
      { date: "2026-10-12", key: "A1" },
      { date: "2026-10-13", key: "A2" },
    ]);
  });

  it("skips a header row and drops every column after the id and the date", () => {
    const r = parseMakeKeys(
      "appointment_id,date,patient_name,phone\nA1,2026-10-12,Sara Test,+971500000000",
      null,
    );
    expect(r.rows).toEqual([{ date: "2026-10-12", key: "A1" }]);
    expect(JSON.stringify(r)).not.toContain("Sara");
    expect(JSON.stringify(r)).not.toContain("971");
  });

  it("rejects ids that look like names or are missing a date, instead of guessing", () => {
    const r = parseMakeKeys("Sara Test\nB1\nC1,not-a-date", "2026-10-12");
    expect(r.rows).toEqual([{ date: "2026-10-12", key: "B1" }]);
    expect(r.rejected).toBe(2);
    expect(parseMakeKeys("A1", null)).toEqual({ rows: [], rejected: 1, truncated: false });
  });

  it("caps an upload", () => {
    const text = Array.from({ length: MAX_MAKE_KEYS_PER_UPLOAD + 10 }, (_, i) => `K${i}`).join(
      "\n",
    );
    const r = parseMakeKeys(text, "2026-10-12");
    expect(r.rows).toHaveLength(MAX_MAKE_KEYS_PER_UPLOAD);
    expect(r.truncated).toBe(true);
  });
});

describe("signOffBlockers", () => {
  const day = (n: number, over: Partial<DayDiff> = {}): DayDiff => ({
    runDate: `2026-10-${String(n).padStart(2, "0")}`,
    makeCount: 10,
    nativeCount: 10,
    onlyInMake: 0,
    onlyInNative: 0,
    noted: false,
    ...over,
  });
  const week = Array.from({ length: 7 }, (_, i) => day(i + 1));
  const base: ScenarioFacts = {
    compareKind: "ids",
    nativeReady: true,
    parallelStartedOn: "2026-10-01",
    today: "2026-10-08",
    diffs: week,
  };

  it("is ready after a clean week", () => {
    expect(signOffBlockers(base)).toEqual([]);
  });

  it("needs the native version, a start date and a full week", () => {
    expect(signOffBlockers({ ...base, nativeReady: false })).toContain(
      "The native version is not marked as built.",
    );
    expect(signOffBlockers({ ...base, parallelStartedOn: null })).toContain(
      "Record the day the parallel run started.",
    );
    expect(signOffBlockers({ ...base, today: "2026-10-04" }).join()).toMatch(
      /needs 7 days; it started 3 day/,
    );
    expect(signOffBlockers({ ...base, diffs: week.slice(0, 5) }).join()).toMatch(
      /Only 5 day\(s\) compared/,
    );
  });

  it("days with no activity prove nothing", () => {
    const quiet = week.map((d, i) => (i < 3 ? d : { ...d, makeCount: 0, nativeCount: 0 }));
    expect(signOffBlockers({ ...base, diffs: quiet }).join()).toMatch(
      /Only 3 day\(s\) had any activity/,
    );
  });

  it("every difference needs an explanation on its day", () => {
    const diffs = [
      ...week.slice(0, 5),
      day(6, { onlyInMake: 2 }),
      day(7, { onlyInNative: 1, noted: true }),
    ];
    expect(signOffBlockers({ ...base, diffs }).join()).toMatch(
      /1 day\(s\) have differences nobody has explained/,
    );
    expect(
      signOffBlockers({
        ...base,
        diffs: [...week.slice(0, 5), day(6, { onlyInMake: 2, noted: true }), day(7)],
      }),
    ).toEqual([]);
  });

  it("ignores days before the parallel run began", () => {
    const early = [day(0 + 1, { onlyInMake: 9 })];
    const f = {
      ...base,
      parallelStartedOn: "2026-10-02",
      today: "2026-10-09",
      diffs: [...early, ...Array.from({ length: 7 }, (_, i) => day(i + 2))],
    };
    expect(signOffBlockers(f)).toEqual([]);
  });

  it("health scenarios (token) are judged by the call success rate", () => {
    const h: ScenarioFacts = { ...base, compareKind: "health", diffs: [] };
    expect(signOffBlockers({ ...h, health: { total: 500, ok: 497 } })).toEqual([]);
    expect(signOffBlockers({ ...h, health: { total: 500, ok: 480 } }).join()).toMatch(/Only 96.0%/);
    expect(signOffBlockers({ ...h, health: { total: 10, ok: 10 } }).join()).toMatch(
      /Not enough Unite calls/,
    );
    expect(signOffBlockers({ ...h, health: null }).join()).toMatch(
      /Not enough Unite calls yet to judge \(0 of 50\)/,
    );
  });

  it("a scenario with no native replacement can never be signed off", () => {
    expect(signOffBlockers({ ...base, compareKind: "none", nativeReady: false })).toEqual([
      "There is no native replacement to compare yet.",
    ]);
  });
});
