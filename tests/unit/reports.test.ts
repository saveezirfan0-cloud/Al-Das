import { describe, expect, it } from "vitest";

import { csvToObjects, parseCsv } from "@/lib/csv";
import { reportFilename, reportToCsv } from "@/lib/reports/export";
import {
  DEFAULT_FILTERS,
  filtersFromSearchParams,
  filtersToSearchParams,
  reportFiltersSchema,
} from "@/lib/reports/filters";
import { formatDuration, formatNumber, formatPercent, formatValue } from "@/lib/reports/format";
import { addDays, resolveRange } from "@/lib/reports/range";
import { getReport, REPORTS, reportStatus } from "@/lib/reports/registry";
import type { ReportResult } from "@/lib/reports/types";

describe("formatting", () => {
  it("formats durations compactly", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(252)).toBe("4m 12s");
    expect(formatDuration(3600)).toBe("1h 00m");
    expect(formatDuration(7500)).toBe("2h 05m");
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });

  it("formats numbers and percentages with a fixed locale", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(null)).toBe("—");
    expect(formatPercent(0.4567)).toBe("45.7%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatValue("12", "number")).toBe("12");
    expect(formatValue(90, "duration")).toBe("1m 30s");
    expect(formatValue(null, "number")).toBe("—");
    expect(formatValue("abc", "number")).toBe("—");
    expect(formatValue("hello")).toBe("hello");
  });
});

describe("filters", () => {
  it("defaults to the last 30 days with no dimension filters", () => {
    expect(DEFAULT_FILTERS).toEqual({ period: "last_30_days", channel_ids: [], team_ids: [], user_ids: [] });
  });

  it("round-trips through the URL", () => {
    const a = "3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
    const b = "4f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e";
    const f = reportFiltersSchema.parse({ period: "custom", from: "2026-01-01", to: "2026-01-31", channel_ids: [a, b], team_ids: [a] });
    const qs = filtersToSearchParams(f);
    expect(qs.toString()).toContain("period=custom");
    const back = filtersFromSearchParams(Object.fromEntries(qs.entries()));
    expect(back.error).toBeNull();
    expect(back.filters).toEqual(f);
  });

  it("omits default values from the URL", () => {
    expect(filtersToSearchParams(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("falls back to defaults with a message on bad input instead of throwing", () => {
    const r = filtersFromSearchParams({ period: "custom", from: "2026-02-01", to: "2026-01-01" });
    expect(r.filters).toEqual(DEFAULT_FILTERS);
    expect(r.error).toMatch(/before the start/);
    expect(filtersFromSearchParams({ period: "forever" }).error).not.toBeNull();
    expect(filtersFromSearchParams({ channel: "not-a-uuid" }).error).not.toBeNull();
    expect(filtersFromSearchParams({ period: "custom" }).error).toMatch(/start and end/);
  });

  it("limits the custom range to a year", () => {
    expect(reportFiltersSchema.safeParse({ period: "custom", from: "2025-01-01", to: "2026-01-02" }).success).toBe(false);
    expect(reportFiltersSchema.safeParse({ period: "custom", from: "2025-01-01", to: "2025-12-31" }).success).toBe(true);
  });
});

describe("resolveRange (org timezone)", () => {
  // 2026-01-15 21:00 UTC is already 2026-01-16 01:00 in Dubai (UTC+4) but still 2026-01-15 in New York.
  const now = new Date("2026-01-15T21:00:00Z");

  it("decides 'today' by the org's local calendar day", () => {
    expect(resolveRange({ period: "today" }, "Asia/Dubai", now).fromDay).toBe("2026-01-16");
    expect(resolveRange({ period: "today" }, "America/New_York", now).fromDay).toBe("2026-01-15");
  });

  it("returns UTC instants for the local day boundaries", () => {
    const r = resolveRange({ period: "today" }, "Asia/Dubai", now);
    expect(r.fromUtc.toISOString()).toBe("2026-01-15T20:00:00.000Z"); // local midnight
    expect(r.toUtcExclusive.toISOString()).toBe("2026-01-16T20:00:00.000Z");
    expect(r.days).toBe(1);
  });

  it("resolves the presets", () => {
    const tz = "Asia/Dubai";
    expect(resolveRange({ period: "yesterday" }, tz, now)).toMatchObject({ fromDay: "2026-01-15", toDay: "2026-01-15" });
    expect(resolveRange({ period: "last_7_days" }, tz, now)).toMatchObject({ fromDay: "2026-01-10", toDay: "2026-01-16", days: 7 });
    expect(resolveRange({ period: "last_30_days" }, tz, now)).toMatchObject({ fromDay: "2025-12-18", toDay: "2026-01-16", days: 30 });
    expect(resolveRange({ period: "this_month" }, tz, now)).toMatchObject({ fromDay: "2026-01-01", toDay: "2026-01-16", days: 16 });
    expect(resolveRange({ period: "last_month" }, tz, now)).toMatchObject({ fromDay: "2025-12-01", toDay: "2025-12-31", days: 31 });
    expect(resolveRange({ period: "custom", from: "2026-01-05", to: "2026-01-07" }, tz, now)).toMatchObject({ days: 3 });
  });

  it("handles month boundaries and leap years", () => {
    const mar = new Date("2024-03-10T12:00:00Z");
    expect(resolveRange({ period: "last_month" }, "UTC", mar)).toMatchObject({ fromDay: "2024-02-01", toDay: "2024-02-29", days: 29 });
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("keeps a DST-length day's UTC span correct", () => {
    // US spring-forward: 2026-03-08 is 23 hours long in New York.
    const r = resolveRange({ period: "custom", from: "2026-03-08", to: "2026-03-08" }, "America/New_York", now);
    expect((r.toUtcExclusive.getTime() - r.fromUtc.getTime()) / 3_600_000).toBe(23);
  });
});

describe("reportToCsv", () => {
  const result: ReportResult = {
    kpis: [],
    charts: [],
    notes: [],
    table: {
      columns: [
        { key: "name", label: "Staff member" },
        { key: "avg", label: "Avg first response", format: "duration" },
        { key: "share", label: "Share", format: "percent" },
        { key: "n", label: "Messages", format: "number" },
      ],
      rows: [
        { name: "Amal, K.", avg: 252, share: 0.4567, n: 12 },
        { name: "=HYPERLINK(\"http://evil\")", avg: null, share: null, n: 0 },
      ],
    },
  };

  it("exports machine-friendly numbers with units in the headers", () => {
    const parsed = csvToObjects(parseCsv(reportToCsv(result)));
    expect(Object.keys(parsed[0])).toEqual(["Staff member", "Avg first response (seconds)", "Share (%)", "Messages"]);
    expect(parsed[0]).toEqual({ "Staff member": "Amal, K.", "Avg first response (seconds)": "252", "Share (%)": "45.7", Messages: "12" });
    expect(parsed[1]["Avg first response (seconds)"]).toBe("");
  });

  it("neutralises spreadsheet formulas in text cells", () => {
    const csv = reportToCsv(result);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).not.toMatch(/(^|,|\n)=HYPERLINK/);
  });

  it("names the file after the report and period", () => {
    expect(reportFilename("agents", "2026-01-01", "2026-01-31")).toBe("pulse-agents-2026-01-01_2026-01-31.csv");
  });
});

describe("registry", () => {
  it("has unique keys and every report names its sources", () => {
    expect(new Set(REPORTS.map((r) => r.key)).size).toBe(REPORTS.length);
    for (const r of REPORTS) expect(r.requires.length, r.key).toBeGreaterThan(0);
    expect(getReport("conversations")?.title).toBe("Conversations");
    expect(getReport("nope")).toBeUndefined();
  });

  it("marks unimplemented reports as awaiting their phase, with the phase named", () => {
    const awaiting = REPORTS.filter((r) => !r.run);
    expect(awaiting.map((r) => r.key).sort()).toEqual(
      ["appointments", "campaigns", "enquiry-funnel", "enquiry-stage-time", "unite-appointments"].sort(),
    );
    for (const r of awaiting) expect(r.awaiting, r.key).toMatch(/Phase \d/);
  });

  it("is live only when implemented AND all source views exist", () => {
    const conversations = getReport("conversations")!;
    expect(reportStatus(conversations, [...conversations.requires, "other"])).toBe("live");
    expect(reportStatus(conversations, ["mv_conversation_facts"])).toBe("unavailable");
    // An awaiting report stays awaiting even if a view with the expected name appears
    expect(reportStatus(getReport("campaigns")!, ["mv_campaign_funnel"])).toBe("awaiting");
  });
});
