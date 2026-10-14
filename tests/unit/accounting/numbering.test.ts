import { describe, expect, it } from "vitest";

import {
  DEFAULT_FY_START_MONTH,
  DEFAULT_PREFIXES,
  fiscalYearCode,
  fiscalYearOf,
  formatJournalNumber,
  periodLabel,
} from "@/lib/accounting/numbering";
import { VOUCHER_TYPES } from "@/lib/accounting/journal";

describe("fiscal years", () => {
  it("defaults to July (owner decision)", () => {
    expect(DEFAULT_FY_START_MONTH).toBe(7);
  });

  it("puts 30 June and 1 July in different July-June years", () => {
    expect(fiscalYearOf(7, "2026-06-30")).toEqual({
      start: "2025-07-01",
      end: "2026-06-30",
      code: "2025-26",
      label: "FY 2025-26",
    });
    expect(fiscalYearOf(7, "2026-07-01")).toEqual({
      start: "2026-07-01",
      end: "2027-06-30",
      code: "2026-27",
      label: "FY 2026-27",
    });
  });

  it("keeps a calendar year when the entity starts in January", () => {
    expect(fiscalYearOf(1, "2026-06-30").label).toBe("FY 2026");
    expect(fiscalYearOf(1, "2026-07-01")).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
      code: "2026",
      label: "FY 2026",
    });
  });

  it("handles a year starting in March (leap February ends the year)", () => {
    expect(fiscalYearOf(3, "2028-02-29").end).toBe("2028-02-29");
    expect(fiscalYearOf(3, "2028-03-01").start).toBe("2028-03-01");
    expect(fiscalYearCode("2099-07-01")).toBe("2099-00");
  });
});

describe("journal numbers", () => {
  it("formats prefix / fiscal year / at least five digits", () => {
    expect(formatJournalNumber("JV", "2026-27", 1)).toBe("JV/2026-27/00001");
    expect(formatJournalNumber("SAL", "2026", 123456)).toBe("SAL/2026/123456");
  });

  it("has a prefix for every voucher type, all different", () => {
    for (const t of VOUCHER_TYPES) expect(DEFAULT_PREFIXES[t], t).toMatch(/^[A-Z]{1,6}$/);
    expect(new Set(Object.values(DEFAULT_PREFIXES)).size).toBe(VOUCHER_TYPES.length);
  });

  it("labels periods, including the adjustment period", () => {
    expect(periodLabel(2026, 7)).toBe("Jul 2026");
    expect(periodLabel(2027, 13, "FY 2026-27")).toBe("FY 2026-27 adjustments");
  });
});
