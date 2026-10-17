import { describe, expect, it } from "vitest";

import {
  AREAS,
  AREA_VIEW_KEY,
  areaStatus,
  canSwitch,
  compare,
  completeMonthTotals,
  fils,
  lastMonths,
  switchedWarning,
  type MonthRow,
} from "@/lib/finance/parallel-run";

describe("compare", () => {
  it("works to the fils: 0.1 + 0.2 against 0.3 is no difference", () => {
    const c = compare(0.1 + 0.2, 0.3, 0);
    expect(c.difference).toBe(0);
    expect(c.state).toBe("agrees");
  });

  it("agrees exactly at the tolerance and differs one fils beyond it", () => {
    expect(compare(1001, 1000, 1).state).toBe("agrees");
    expect(compare(999, 1000, 1).state).toBe("agrees");
    const over = compare(1001.001, 1000, 1);
    expect(over.state).toBe("differs");
    expect(over.difference).toBe(1.001);
    expect(compare(998.999, 1000, 1).difference).toBe(-1.001);
  });

  it("a zero tolerance accepts only an exact match", () => {
    expect(compare(5, 5, 0).state).toBe("agrees");
    expect(compare(5.001, 5, 0).state).toBe("differs");
  });

  it("a month not entered is no_manual, never zero, even when Pulse is zero", () => {
    const c = compare(0, null, 1000);
    expect(c).toEqual({ pulse: 0, manual: null, difference: null, state: "no_manual" });
  });

  it("a typed zero is a real manual figure", () => {
    expect(compare(0, 0, 0).state).toBe("agrees");
    expect(compare(10, 0, 1).state).toBe("differs");
  });

  it("a missing or invalid Pulse figure is no_pulse, never agreement", () => {
    expect(compare(null, 0, 1000).state).toBe("no_pulse");
    expect(compare(Number.NaN, 5, 1000).state).toBe("no_pulse");
  });

  it("fils rounds to whole thousandths", () => {
    expect(fils(1234.5678)).toBe(1234568);
  });
});

const row = (month: string, pulse: number | null, manual: number | null): MonthRow => ({
  month,
  pulse,
  manual,
});

describe("canSwitch", () => {
  const latest = "2026-09";
  it("is ok when the two latest consecutive months agree", () => {
    expect(canSwitch([row("2026-09", 100, 100), row("2026-08", 200, 200.5)], latest, 1)).toEqual({
      ok: true,
    });
  });

  it("is refused when the newest month differs", () => {
    const r = canSwitch([row("2026-09", 100, 120), row("2026-08", 200, 200)], latest, 1);
    expect(r).toEqual({ ok: false, reason: "2026-09 does not agree yet." });
  });

  it("is refused when the month before differs", () => {
    const r = canSwitch([row("2026-09", 100, 100), row("2026-08", 200, 260)], latest, 1);
    expect(r.ok).toBe(false);
  });

  it("a gap month breaks it: July and September agreeing is not enough", () => {
    const r = canSwitch([row("2026-09", 100, 100), row("2026-07", 100, 100)], latest, 1);
    expect(r).toEqual({ ok: false, reason: "No manual figure for 2026-08 yet." });
  });

  it("needs the last finished month: older agreeing months do not count", () => {
    const r = canSwitch([row("2026-08", 100, 100), row("2026-07", 100, 100)], latest, 1);
    expect(r.ok).toBe(false);
  });

  it("a month without a manual figure or without a Pulse figure is refused", () => {
    expect(canSwitch([row("2026-09", 100, null), row("2026-08", 1, 1)], latest, 1).ok).toBe(false);
    const r = canSwitch([row("2026-09", null, 100), row("2026-08", 1, 1)], latest, 1);
    expect(r).toEqual({ ok: false, reason: "Pulse has no figure for 2026-09." });
  });

  it("works across a year end", () => {
    expect(canSwitch([row("2027-01", 5, 5), row("2026-12", 7, 7)], "2027-01", 0).ok).toBe(true);
  });

  it("an empty list is refused", () => {
    expect(canSwitch([], latest, 1).ok).toBe(false);
  });
});

describe("status and warning", () => {
  it("not started until a manual figure exists; the stored decision wins", () => {
    expect(areaStatus(null, false)).toBe("not_started");
    expect(areaStatus(null, true)).toBe("running");
    expect(areaStatus("running", false)).toBe("running");
    expect(areaStatus("switched", false)).toBe("switched");
  });

  it("a switched area that stops agreeing keeps its status and shows a warning", () => {
    const check = canSwitch([row("2026-09", 100, 500), row("2026-08", 1, 1)], "2026-09", 1);
    expect(areaStatus("switched", true)).toBe("switched");
    expect(switchedWarning("switched", check)).toContain("no longer agree");
    expect(switchedWarning("running", check)).toBeNull();
    expect(switchedWarning("switched", { ok: true })).toBeNull();
  });
});

describe("lastMonths and areas", () => {
  it("lists months newest first across a year end", () => {
    expect(lastMonths("2027-01", 3)).toEqual(["2027-01", "2026-12", "2026-11"]);
  });

  it("every area has its own view key", () => {
    for (const a of AREAS) expect(AREA_VIEW_KEY[a]).toMatch(/^finance\./);
  });
});

describe("completeMonthTotals", () => {
  const owners = new Set(["a", "b"]);
  it("sums only when every owner has a figure for the month", () => {
    const rows = [
      { month: "2026-09-01", owner: "a", value: 10.5 },
      { month: "2026-09-01", owner: "b", value: 4 },
      { month: "2026-08-01", owner: "a", value: 7 },
    ];
    expect(completeMonthTotals(rows, owners, ["2026-09", "2026-08", "2026-07"])).toEqual({
      "2026-09": 14.5,
      "2026-08": null,
      "2026-07": null,
    });
  });
  it("an owner with an unreadable figure, or no owners at all, is not available", () => {
    const rows = [
      { month: "2026-09-01", owner: "a", value: 1 },
      { month: "2026-09-01", owner: "b", value: null },
    ];
    expect(completeMonthTotals(rows, owners, ["2026-09"])["2026-09"]).toBeNull();
    expect(completeMonthTotals(rows, new Set(), ["2026-09"])["2026-09"]).toBeNull();
  });
  it("ignores rows of owners that are not expected (an inactive account)", () => {
    const rows = [
      { month: "2026-09-01", owner: "a", value: 1 },
      { month: "2026-09-01", owner: "x", value: 99 },
    ];
    expect(completeMonthTotals(rows, new Set(["a"]), ["2026-09"])["2026-09"]).toBe(1);
  });
});
