import { describe, expect, it } from "vitest";

import { startOfLocalDay, taskStateRange } from "@/lib/tasks/range";

const DUBAI = "Asia/Dubai"; // UTC+4, no DST
const LONDON = "Europe/London"; // DST changes

describe("startOfLocalDay", () => {
  it("snaps to local midnight, not UTC midnight", () => {
    // 21:30 UTC on the 9th is 01:30 on the 10th in Dubai.
    expect(startOfLocalDay(new Date("2026-10-09T21:30:00Z"), DUBAI).toISOString()).toBe(
      "2026-10-09T20:00:00.000Z",
    );
    expect(startOfLocalDay(new Date("2026-10-09T10:00:00Z"), DUBAI).toISOString()).toBe(
      "2026-10-08T20:00:00.000Z",
    );
  });
});

describe("taskStateRange", () => {
  const now = new Date("2026-10-09T10:00:00Z");

  it("maps the simple states", () => {
    expect(taskStateRange("open", now, DUBAI)).toEqual({ done: false });
    expect(taskStateRange("done", now, DUBAI)).toEqual({ done: true });
    expect(taskStateRange("all", now, DUBAI)).toEqual({});
    expect(taskStateRange("overdue", now, DUBAI)).toEqual({ done: false, dueBefore: now });
  });

  it("'today' is the org-local calendar day", () => {
    const r = taskStateRange("today", now, DUBAI);
    expect(r.done).toBe(false);
    expect(r.dueFrom?.toISOString()).toBe("2026-10-08T20:00:00.000Z");
    expect(r.dueTo?.toISOString()).toBe("2026-10-09T20:00:00.000Z");
  });

  it("still ends at the next local midnight on a 25-hour DST day", () => {
    // Clocks go back in London on 2026-10-25: that day has 25 hours.
    const r = taskStateRange("today", new Date("2026-10-25T12:00:00Z"), LONDON);
    expect(r.dueFrom?.toISOString()).toBe("2026-10-24T23:00:00.000Z");
    expect(r.dueTo?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("still ends at the next local midnight on a 23-hour DST day", () => {
    // Clocks go forward in London on 2026-03-29: that day has 23 hours.
    const r = taskStateRange("today", new Date("2026-03-29T12:00:00Z"), LONDON);
    expect(r.dueFrom?.toISOString()).toBe("2026-03-29T00:00:00.000Z");
    expect(r.dueTo?.toISOString()).toBe("2026-03-29T23:00:00.000Z");
  });
});
