import { describe, expect, it } from "vitest";

import { classifyDue, isTaskType, needsDueNotice, TASK_TYPES } from "@/lib/tasks/due";
import { createTaskSchema, taskFilterSchema, updateTaskSchema } from "@/lib/tasks/schemas";

// 2026-05-01 10:00 in Dubai (UTC+4)
const now = new Date("2026-05-01T06:00:00Z");

describe("classifyDue", () => {
  const t = (due_at: string | null, done = false) => ({ done, due_at });
  it("labels done, none, overdue, today and upcoming", () => {
    expect(classifyDue(t("2026-04-01T00:00:00Z", true), now)).toBe("done");
    expect(classifyDue(t(null), now)).toBe("none");
    expect(classifyDue(t("2026-04-30T19:00:00Z"), now)).toBe("overdue");
    expect(classifyDue(t("2026-05-01T05:00:00Z"), now)).toBe("today"); // earlier today: still today's list
    expect(classifyDue(t("2026-05-01T12:00:00Z"), now)).toBe("today");
    expect(classifyDue(t("2026-05-02T12:00:00Z"), now)).toBe("upcoming");
    expect(classifyDue(t("garbage"), now)).toBe("none");
  });
  it("uses the clinic's calendar day, not UTC", () => {
    // 21:00 UTC on 30 April is 01:00 on 1 May in Dubai: same day as `now` there.
    expect(classifyDue(t("2026-04-30T21:00:00Z"), now, "Asia/Dubai")).toBe("today");
    expect(classifyDue(t("2026-04-30T21:00:00Z"), now, "UTC")).toBe("overdue");
  });
});

describe("needsDueNotice", () => {
  const base = {
    done: false,
    due_at: "2026-05-01T05:00:00Z",
    assignee_id: "u",
    due_notified_at: null,
  };
  it("fires once for open, assigned, due tasks", () => {
    expect(needsDueNotice(base, now)).toBe(true);
    expect(needsDueNotice({ ...base, due_at: "2026-05-01T07:00:00Z" }, now)).toBe(false);
    expect(needsDueNotice({ ...base, done: true }, now)).toBe(false);
    expect(needsDueNotice({ ...base, assignee_id: null }, now)).toBe(false);
    expect(needsDueNotice({ ...base, due_notified_at: "2026-05-01T05:30:00Z" }, now)).toBe(false);
    expect(needsDueNotice({ ...base, due_at: null }, now)).toBe(false);
  });
});

describe("task schemas", () => {
  it("validates input", () => {
    expect(createTaskSchema.safeParse({ subject: "  " }).success).toBe(false);
    expect(createTaskSchema.parse({ subject: " Call back " })).toEqual({ subject: "Call back" });
    expect(createTaskSchema.safeParse({ subject: "x", type: "nope" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ subject: "x", due_at: "tomorrow" }).success).toBe(false);
    expect(updateTaskSchema.parse({ notes: "" })).toEqual({ notes: null });
    expect(taskFilterSchema.parse({})).toMatchObject({ scope: "mine", state: "open" });
    expect(taskFilterSchema.safeParse({ assignee_id: "x" }).success).toBe(false);
  });
  it("knows the task types", () => {
    expect(TASK_TYPES).toContain("call");
    expect(isTaskType("call")).toBe(true);
    expect(isTaskType("x")).toBe(false);
  });
});
