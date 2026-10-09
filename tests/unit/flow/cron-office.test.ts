import { describe, expect, it } from "vitest";

import { CronError, cronMatches, isValidCron, minuteKey, parseCron } from "@/lib/flow-engine/cron";
import { isOfficeOpen } from "@/lib/flow-engine/office-hours";

// 2026-10-12 is a Monday. Dubai = UTC+4.
const at = (iso: string) => new Date(iso);

describe("cron", () => {
  it("matches minute/hour in the given time zone", () => {
    expect(cronMatches("0 9 * * *", at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(true);
    expect(cronMatches("0 9 * * *", at("2026-10-12T09:00:00Z"), "Asia/Dubai")).toBe(false);
    expect(cronMatches("0 9 * * *", at("2026-10-12T09:00:00Z"), "UTC")).toBe(true);
  });

  it("supports steps, lists and ranges", () => {
    expect(cronMatches("*/15 * * * *", at("2026-10-12T05:45:00Z"), "UTC")).toBe(true);
    expect(cronMatches("*/15 * * * *", at("2026-10-12T05:46:00Z"), "UTC")).toBe(false);
    expect(cronMatches("0 8-10 * * *", at("2026-10-12T09:00:00Z"), "UTC")).toBe(true);
    expect(cronMatches("0 8,12 * * *", at("2026-10-12T09:00:00Z"), "UTC")).toBe(false);
  });

  it("day of week: 0 and 7 are Sunday, Monday is 1", () => {
    expect(cronMatches("0 9 * * 1", at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(true);
    expect(cronMatches("0 9 * * 0", at("2026-10-18T05:00:00Z"), "Asia/Dubai")).toBe(true);
    expect(cronMatches("0 9 * * 7", at("2026-10-18T05:00:00Z"), "Asia/Dubai")).toBe(true);
    expect(cronMatches("0 9 * * 1-5", at("2026-10-17T05:00:00Z"), "Asia/Dubai")).toBe(false); // Saturday
  });

  it("restricted day-of-month and day-of-week match on either, like cron", () => {
    expect(cronMatches("0 9 15 * 1", at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(true); // Monday, not the 15th
    expect(cronMatches("0 9 12 * 2", at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(true); // the 12th, not Tuesday
    expect(cronMatches("0 9 13 * 2", at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(false);
  });

  it("rejects malformed schedules", () => {
    for (const bad of [
      "",
      "* * * *",
      "61 * * * *",
      "* 24 * * *",
      "*/0 * * * *",
      "a * * * *",
      "5-2 * * * *",
    ]) {
      expect(isValidCron(bad), bad).toBe(false);
    }
    expect(() => parseCron("* * * *")).toThrow(CronError);
    expect(isValidCron("*/5 9-17 * * 1-5")).toBe(true);
  });

  it("minute keys differ per minute and per zone", () => {
    expect(minuteKey(at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe("202610120900");
    expect(minuteKey(at("2026-10-12T05:01:00Z"), "Asia/Dubai")).toBe("202610120901");
  });
});

describe("office hours", () => {
  const week = {
    mon: [{ from: "09:00", to: "18:00" }],
    tue: [
      { from: "09:00", to: "13:00" },
      { from: "15:00", to: "18:00" },
    ],
  };

  it("is open inside a window and closed outside, in the zone's own clock", () => {
    expect(isOfficeOpen(week, at("2026-10-12T05:00:00Z"), "Asia/Dubai")).toBe(true); // Mon 09:00
    expect(isOfficeOpen(week, at("2026-10-12T04:59:00Z"), "Asia/Dubai")).toBe(false); // 08:59
    expect(isOfficeOpen(week, at("2026-10-12T14:00:00Z"), "Asia/Dubai")).toBe(false); // 18:00 end is exclusive
  });

  it("supports split days and closed days", () => {
    expect(isOfficeOpen(week, at("2026-10-13T10:00:00Z"), "Asia/Dubai")).toBe(false); // Tue 14:00 lunch
    expect(isOfficeOpen(week, at("2026-10-13T11:00:00Z"), "Asia/Dubai")).toBe(true); // Tue 15:00
    expect(isOfficeOpen(week, at("2026-10-14T06:00:00Z"), "Asia/Dubai")).toBe(false); // Wed closed
  });

  it("windows past midnight spill into the next day", () => {
    const night = { mon: [{ from: "22:00", to: "02:00" }] };
    expect(isOfficeOpen(night, at("2026-10-12T19:00:00Z"), "Asia/Dubai")).toBe(true); // Mon 23:00
    expect(isOfficeOpen(night, at("2026-10-12T21:00:00Z"), "Asia/Dubai")).toBe(true); // Tue 01:00
    expect(isOfficeOpen(night, at("2026-10-12T23:00:00Z"), "Asia/Dubai")).toBe(false); // Tue 03:00
  });
});
