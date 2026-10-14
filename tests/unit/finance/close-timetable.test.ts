/**
 * Phase 20G: the working-day calendar, due dates, reminders and the close measures (pure). Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  addMonths,
  ageDays,
  backupCoverage,
  closeDelivery,
  closeMonthFor,
  dueOn,
  inputsOnTime,
  isoWeekday,
  isWorkingDay,
  lateness,
  monthKpis,
  remindersByRecipient,
  tasksToRemind,
  workingDay,
  workingDayOf,
  type KpiTask,
  type TaskStatus,
  type WorkCalendar,
} from "@/lib/finance/close-timetable";

import fixture from "./fixtures/close-timetable.synthetic.json";

const UAE: WorkCalendar = { weekend: [6, 7], holidays: [] };
const WITH_NATIONAL_DAY: WorkCalendar = { weekend: [6, 7], holidays: ["2026-12-02", "2026-12-03"] };

describe("working-day calendar", () => {
  it("knows ISO weekdays (1 = Monday .. 7 = Sunday) and refuses dates that do not exist", () => {
    expect(isoWeekday("2026-10-13")).toBe(2); // a Tuesday
    expect(isoWeekday("2026-11-01")).toBe(7); // a Sunday
    expect(isoWeekday("2026-08-01")).toBe(6); // a Saturday
    expect(isoWeekday("1969-12-31")).toBe(3); // before day 0 still works
    expect(isoWeekday("2026-02-30")).toBeNull();
    expect(isWorkingDay("2026-10-10", UAE)).toBe(false);
    expect(isWorkingDay("2026-10-12", UAE)).toBe(true);
    expect(isWorkingDay("2026-12-02", WITH_NATIONAL_DAY)).toBe(false);
    expect(isWorkingDay("not a date", UAE)).toBe(false);
  });

  it("counts working days from the 1st, skipping the weekend (October 2026 starts on a Thursday)", () => {
    expect(workingDay("2026-10", 1, UAE)).toBe("2026-10-01");
    expect(workingDay("2026-10", 2, UAE)).toBe("2026-10-02");
    expect(workingDay("2026-10", 3, UAE)).toBe("2026-10-05"); // Sat 3 and Sun 4 skipped
    expect(workingDay("2026-10-01", 5, UAE)).toBe("2026-10-07");
    expect(workingDay("2026-10", 10, UAE)).toBe("2026-10-14");
  });

  it("handles a month that starts on a weekend (November 2026 starts on a Sunday, August on a Saturday)", () => {
    expect(workingDay("2026-11", 1, UAE)).toBe("2026-11-02");
    expect(workingDay("2026-11", 5, UAE)).toBe("2026-11-06");
    expect(workingDay("2026-08", 1, UAE)).toBe("2026-08-03");
    expect(workingDayOf("2026-11-01", UAE)).toBe(0);
    expect(workingDayOf("2026-08-02", UAE)).toBe(0);
  });

  it("skips public holidays (National Day moves December's WD5 from the 7th to the 9th)", () => {
    expect(workingDay("2026-12", 5, UAE)).toBe("2026-12-07");
    expect(workingDay("2026-12", 5, WITH_NATIONAL_DAY)).toBe("2026-12-09");
    expect(workingDay("2026-12", 2, WITH_NATIONAL_DAY)).toBe("2026-12-04");
  });

  it("follows another weekend setting (Friday and Saturday)", () => {
    const friSat: WorkCalendar = { weekend: [5, 6], holidays: [] };
    expect(workingDay("2026-10", 2, friSat)).toBe("2026-10-04");
    expect(workingDay("2026-10", 5, friSat)).toBe("2026-10-07");
  });

  it("runs past the end of a short month and stops at the limits", () => {
    expect(workingDay("2027-02", 20, UAE)).toBe("2027-02-26");
    expect(workingDay("2027-02", 21, UAE)).toBe("2027-03-01");
    expect(workingDay("2027-02", 23, UAE)).toBe("2027-03-03");
    expect(workingDay("2027-02", 24, UAE)).toBeNull();
    expect(workingDay("2027-02", 0, UAE)).toBeNull();
    expect(workingDay("2027-02", 1.5, UAE)).toBeNull();
    expect(workingDay("2027-13", 1, UAE)).toBeNull();
    expect(workingDay("2026-10", 1, { weekend: [1, 2, 3, 4, 5, 6, 7], holidays: [] })).toBeNull();
  });

  it("says which working day a date is (a weekend day keeps the count of the Friday before)", () => {
    expect(workingDayOf("2026-10-01", UAE)).toBe(1);
    expect(workingDayOf("2026-10-03", UAE)).toBe(2);
    expect(workingDayOf("2026-10-13", UAE)).toBe(9);
    expect(workingDayOf("2026-10-31", UAE)).toBe(22);
    expect(workingDayOf("2026-12-03", WITH_NATIONAL_DAY)).toBe(1);
    expect(workingDayOf("bad", UAE)).toBe(0);
  });

  it("dates a close month's steps in the month after it, across the year end", () => {
    expect(closeMonthFor("2026-10-13")).toBe("2026-09-01");
    expect(closeMonthFor("2027-01-05")).toBe("2026-12-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01-01", -1)).toBe("2025-12-01");
    expect(dueOn("2026-09-01", 5, UAE)).toBe("2026-10-07");
    expect(dueOn("2026-09-01", 10, UAE)).toBe("2026-10-14");
    expect(dueOn("2026-10-01", 5, UAE)).toBe("2026-11-06");
    expect(dueOn("2026-11-01", 5, WITH_NATIONAL_DAY)).toBe("2026-12-09");
    expect(dueOn("2026-12-01", 1, UAE)).toBe("2027-01-01");
  });
});

describe("due and overdue", () => {
  it("marks unfinished steps due today or late; done steps never", () => {
    expect(lateness("open", "2026-10-07", "2026-10-06")).toBe("none");
    expect(lateness("open", "2026-10-07", "2026-10-07")).toBe("due_today");
    expect(lateness("blocked", "2026-10-07", "2026-10-08")).toBe("overdue");
    expect(lateness("done", "2026-10-07", "2026-10-30")).toBe("none");
    expect(lateness("open", null, "2026-10-30")).toBe("none");
  });

  it("reminds about open and blocked steps due today or earlier", () => {
    const tasks: { id: string; status: TaskStatus; dueOn: string | null }[] = [
      { id: "a", status: "open", dueOn: "2026-10-07" },
      { id: "b", status: "blocked", dueOn: "2026-10-13" },
      { id: "c", status: "done", dueOn: "2026-10-07" },
      { id: "d", status: "open", dueOn: "2026-10-14" },
      { id: "e", status: "open", dueOn: null },
    ];
    expect(tasksToRemind(tasks, "2026-10-13")).toEqual(["a", "b"]);
  });

  it("sends one reminder per person, and an unowned step to the close managers", () => {
    const m = remindersByRecipient(
      [
        { task_id: "1", owner_user_id: "u1" },
        { task_id: "2", owner_user_id: "u1" },
        { task_id: "3", owner_user_id: "u2" },
        { task_id: "4", owner_user_id: null },
      ],
      ["m1", "u1", "m1"],
    );
    expect(Object.fromEntries(m)).toEqual({ u1: 3, u2: 1, m1: 1 });
    expect(remindersByRecipient([{ task_id: "4", owner_user_id: null }], []).size).toBe(0);
  });
});

describe("close measures (synthetic fixture)", () => {
  const cal = fixture.calendar as WorkCalendar;
  const tasks = fixture.tasks.map((t) => ({
    month: t.month,
    status: t.status as TaskStatus,
    dueWd: t.dueWd,
    dueOn: dueOn(t.month, t.dueWd, cal),
    doneOn: t.doneOn,
  }));

  it("inputs by WD5: on time, late (done late, not done, blocked), and later steps ignored", () => {
    const sep = inputsOnTime(
      tasks.filter((t) => t.month === "2026-09-01"),
      fixture.inputsWd,
      fixture.today,
    );
    expect(sep).toEqual({ total: 4, onTime: 1, late: 3, pending: 0, rate: 0.25 });
    // a day before WD5 the unfinished inputs are pending, not late
    const early = inputsOnTime(
      tasks.filter((t) => t.month === "2026-09-01"),
      5,
      "2026-10-06",
    );
    expect(early).toEqual({ total: 4, onTime: 1, late: 1, pending: 2, rate: 0.5 });
    expect(inputsOnTime([], 5, fixture.today).rate).toBeNull();
  });

  it("an input with no due date fails closed (late)", () => {
    const t: KpiTask = { status: "done", dueWd: 5, dueOn: null, doneOn: "2026-10-01" };
    expect(inputsOnTime([t], 5, "2026-10-01")).toMatchObject({ late: 1, onTime: 0, rate: 0 });
  });

  it("close delivered by WD10: on time, late, missed, not due yet", () => {
    expect(closeDelivery("2026-10-14", "2026-10-14", "2026-10-20")).toBe("on_time");
    expect(closeDelivery("2026-10-15", "2026-10-14", "2026-10-20")).toBe("late");
    expect(closeDelivery(null, "2026-10-14", "2026-10-15")).toBe("missed");
    expect(closeDelivery(null, "2026-10-14", "2026-10-14")).toBe("open");
    expect(closeDelivery("2026-10-01", null, "2026-10-14")).toBe("open");
  });

  it("builds the month rows newest first from tasks and lock dates", () => {
    const rows = monthKpis({
      months: fixture.months,
      tasks,
      lockedOn: fixture.lockedOn,
      cal,
      inputsWd: fixture.inputsWd,
      deadlineWd: fixture.deadlineWd,
      today: fixture.today,
    });
    expect(
      rows.map((r) => ({
        month: r.month,
        rate: r.inputs.rate,
        deadline: r.deadlineOn,
        delivery: r.delivery,
      })),
    ).toEqual([
      { month: "2026-09-01", rate: 0.25, deadline: "2026-10-14", delivery: "open" },
      { month: "2026-08-01", rate: 1, deadline: "2026-09-14", delivery: "on_time" },
      { month: "2026-07-01", rate: null, deadline: "2026-08-14", delivery: "late" },
    ]);
  });

  it("single-person dependency: active steps without a different backup are listed", () => {
    expect(backupCoverage(fixture.steps)).toEqual({
      total: 4,
      covered: 1,
      missing: ["REVENUE_UNITE", "BANK_CASH", "HR_INPUTS"],
      rate: 0.25,
    });
    expect(backupCoverage([]).rate).toBeNull();
  });

  it("ages reconciling items in whole days", () => {
    expect(ageDays("2026-08-14", "2026-10-13")).toBe(60);
    expect(ageDays("2026-10-14", "2026-10-13")).toBe(0);
    expect(ageDays(null, "2026-10-13")).toBeNull();
  });
});
