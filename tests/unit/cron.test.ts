import { describe, expect, it } from "vitest";

import { cronMatches, isValidCron } from "@/lib/cron";

// 2026-10-12 is a Monday. 08:15Z = 12:15 Asia/Dubai.
const monday1215 = new Date("2026-10-12T08:15:00Z");

describe("cron", () => {
  it("matches in the given timezone", () => {
    expect(cronMatches("15 12 * * *", monday1215, "Asia/Dubai")).toBe(true);
    expect(cronMatches("15 12 * * *", monday1215, "UTC")).toBe(false);
    expect(cronMatches("15 8 * * *", monday1215, "UTC")).toBe(true);
  });
  it("supports lists, ranges and steps", () => {
    expect(cronMatches("0,15,30 12 * * *", monday1215)).toBe(true);
    expect(cronMatches("10-20 12 * * *", monday1215)).toBe(true);
    expect(cronMatches("*/5 12 * * *", monday1215)).toBe(true);
    expect(cronMatches("*/7 12 * * *", monday1215)).toBe(false);
    expect(cronMatches("0 12,18 * * *", new Date("2026-10-12T14:00:00Z"))).toBe(true); // 18:00 Dubai
  });
  it("handles day-of-week (0 and 7 are Sunday) and day-of-month", () => {
    expect(cronMatches("15 12 * * 1", monday1215)).toBe(true);
    expect(cronMatches("15 12 * * 1-5", monday1215)).toBe(true);
    expect(cronMatches("15 12 * * 0", monday1215)).toBe(false);
    const sunday = new Date("2026-10-11T08:15:00Z");
    expect(cronMatches("15 12 * * 0", sunday)).toBe(true);
    expect(cronMatches("15 12 * * 7", sunday)).toBe(true);
    expect(cronMatches("15 12 12 * *", monday1215)).toBe(true);
    expect(cronMatches("15 12 13 * 1", monday1215)).toBe(true); // either dom or dow
    expect(cronMatches("15 12 13 * 2", monday1215)).toBe(false);
  });
  it("rejects invalid expressions", () => {
    for (const bad of [
      "",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "a b c d e",
      "*/0 * * * *",
      "5-1 * * * *",
    ]) {
      expect(isValidCron(bad), bad).toBe(false);
      expect(cronMatches(bad, monday1215)).toBe(false);
    }
    expect(isValidCron("0 9 * * 1-5")).toBe(true);
  });
});
