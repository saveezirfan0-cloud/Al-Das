import { describe, expect, it } from "vitest";

import {
  dueState,
  reminderDedupeKey,
  reminderRunAt,
  reminderStillValid,
} from "@/lib/tasks/due";

const NOW = new Date("2026-10-09T10:00:00Z");
const mins = (m: number) => new Date(NOW.getTime() + m * 60_000);

describe("dueState", () => {
  it("classifies open tasks", () => {
    expect(dueState({ done: false, due_at: mins(-1) }, NOW)).toBe("overdue");
    expect(dueState({ done: false, due_at: mins(30) }, NOW)).toBe("today");
    expect(dueState({ done: false, due_at: mins(60 * 30) }, NOW)).toBe("upcoming");
  });

  it("done tasks are never overdue", () => {
    expect(dueState({ done: true, due_at: mins(-500) }, NOW)).toBe("done");
  });

  it("uses the caller's day key (timezone-aware 'today')", () => {
    // 23:30 UTC is already the next day in Dubai (UTC+4).
    const late = new Date("2026-10-09T23:30:00Z");
    const dubai = (d: Date) => new Date(d.getTime() + 4 * 3600_000).toISOString().slice(0, 10);
    expect(dueState({ done: false, due_at: late }, NOW)).toBe("today");
    expect(dueState({ done: false, due_at: late }, NOW, dubai)).toBe("upcoming");
  });
});

describe("reminders", () => {
  it("fires `lead` minutes before the due time", () => {
    expect(reminderRunAt(mins(60), 15, NOW)?.toISOString()).toBe(mins(45).toISOString());
    expect(reminderRunAt(mins(60), 0, NOW)?.toISOString()).toBe(mins(60).toISOString());
  });

  it("fires immediately when the lead window has already started, never in the past", () => {
    expect(reminderRunAt(mins(10), 30, NOW)?.toISOString()).toBe(NOW.toISOString());
  });

  it("does not remind about tasks that are already overdue", () => {
    expect(reminderRunAt(mins(-5), 0, NOW)).toBeNull();
    expect(reminderRunAt(NOW, 0, NOW)).toBeNull();
  });

  it("keys the pending job by task and due time", () => {
    const a = reminderDedupeKey("t1", mins(60));
    expect(a).toBe(reminderDedupeKey("t1", mins(60)));
    expect(a).not.toBe(reminderDedupeKey("t1", mins(90)));
    expect(a).not.toBe(reminderDedupeKey("t2", mins(60)));
  });

  it("drops stale reminders: completed or moved tasks", () => {
    const due = mins(60);
    expect(reminderStillValid({ done: false, due_at: due }, due.toISOString())).toBe(true);
    expect(reminderStillValid({ done: true, due_at: due }, due.toISOString())).toBe(false);
    expect(reminderStillValid({ done: false, due_at: mins(120) }, due.toISOString())).toBe(false);
  });
});
