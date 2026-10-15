/**
 * Phase E (docs/34): diary helpers. Drag-and-drop decisions, snapping, the branch week grid and the check-in chip.
 */
import { describe, expect, it } from "vitest";

import { CHECKIN_CHIP, checkinChip } from "@/app/(app)/appointments/format";
import { dragMoveDecision, snapMinute, type DragAppt } from "@/lib/appointments/drag-move";
import { weekDates, weekGrid } from "@/lib/appointments/week";
import { CHECKIN_STATES } from "@/lib/front-desk/checkin";

const now = new Date("2026-10-14T05:00:00.000Z");
const appt = (over: Partial<DragAppt> = {}): DragAppt => ({
  status: "awaiting",
  source: "portal",
  checkin_status: null,
  reminder: null,
  starts_at: "2026-10-14T06:00:00.000Z",
  specialist_id: "d1",
  ...over,
});
const to = (startIso: string, specialistId = "d1") => ({ startIso, specialistId });

describe("drag-and-drop move decision", () => {
  it("ignores a drop on the same place", () => {
    expect(dragMoveDecision(appt(), to("2026-10-14T06:00:00.000Z"), now, true)).toEqual({
      kind: "same",
    });
  });

  it("moves to another time or another doctor", () => {
    expect(dragMoveDecision(appt(), to("2026-10-14T07:00:00.000Z"), now, true)).toEqual({
      kind: "go",
    });
    expect(dragMoveDecision(appt(), to("2026-10-14T06:00:00.000Z", "d2"), now, true)).toEqual({
      kind: "go",
    });
  });

  it("refuses Unite bookings, closed visits, checked-in patients and the past", () => {
    const refuse = (a: DragAppt, start = "2026-10-14T07:00:00.000Z") =>
      dragMoveDecision(a, to(start), now, true).kind;
    expect(refuse(appt({ source: "unite" }))).toBe("refuse");
    for (const status of ["cancelled", "completed", "no_show"])
      expect(refuse(appt({ status }))).toBe("refuse");
    expect(refuse(appt({ checkin_status: "arrived" }))).toBe("refuse");
    expect(refuse(appt(), "2026-10-14T04:00:00.000Z")).toBe("refuse");
    expect(refuse(appt(), "not a time")).toBe("refuse");
  });

  it("asks before moving a confirmed visit whose reminder went out, saying whether the patient is told", () => {
    const sent = appt({ status: "confirmed", reminder: "sent" });
    const told = dragMoveDecision(sent, to("2026-10-14T07:00:00.000Z"), now, true);
    expect(told.kind).toBe("confirm");
    if (told.kind === "confirm") expect(told.description).toMatch(/patient will be told/);
    const quiet = dragMoveDecision(sent, to("2026-10-14T07:00:00.000Z"), now, false);
    if (quiet.kind === "confirm") expect(quiet.description).toMatch(/will NOT be told/);
    // Not confirmed yet, or no reminder sent: no question.
    expect(
      dragMoveDecision(appt({ reminder: "sent" }), to("2026-10-14T07:00:00.000Z"), now, true).kind,
    ).toBe("go");
    expect(
      dragMoveDecision(
        appt({ status: "confirmed", reminder: "scheduled" }),
        to("2026-10-14T07:00:00.000Z"),
        now,
        true,
      ).kind,
    ).toBe("go");
  });
});

describe("snapping a dragged block", () => {
  it("rounds to the slot length and keeps the whole visit inside the day shown", () => {
    expect(snapMinute(9 * 60 + 7, 15, 8 * 60, 18 * 60, 30)).toBe(9 * 60 + 15 - 15); // 547 → 540
    expect(snapMinute(9 * 60 + 8, 15, 8 * 60, 18 * 60, 30)).toBe(9 * 60 + 15);
    expect(snapMinute(7 * 60, 15, 8 * 60, 18 * 60, 30)).toBe(8 * 60);
    expect(snapMinute(17 * 60 + 50, 15, 8 * 60, 18 * 60, 30)).toBe(17 * 60 + 30);
    expect(snapMinute(600, 0, 0, 1440, 30)).toBe(600); // a zero step never divides by zero
  });
});

describe("branch week", () => {
  it("gives Monday to Sunday of the week holding the date", () => {
    expect(weekDates("2026-10-14")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
      "2026-10-17",
      "2026-10-18",
    ]);
    expect(weekDates("2026-10-18")[0]).toBe("2026-10-12"); // Sunday belongs to the week before
    expect(weekDates("2026-10-12")[6]).toBe("2026-10-18");
    expect(weekDates("2027-01-01")[0]).toBe("2026-12-28"); // across a year end
  });

  it("puts each booking under its doctor and local day, in time order, and skips cancelled ones", () => {
    const days = weekDates("2026-10-14");
    const a = (
      id: string,
      starts_at: string,
      specialist_id: string | null,
      status = "confirmed",
    ) => ({
      id,
      starts_at,
      specialist_id,
      status,
    });
    const rows = weekGrid(
      [
        a("late", "2026-10-14T10:00:00.000Z", "d1"),
        a("early", "2026-10-14T05:00:00.000Z", "d1"),
        a("x", "2026-10-14T06:00:00.000Z", "d1", "cancelled"),
        a("night", "2026-10-12T21:00:00.000Z", "d2"), // 01:00 on Tuesday in Dubai
        a("stranger", "2026-10-15T06:00:00.000Z", "dX"),
        a("outside", "2026-10-20T06:00:00.000Z", "d1"),
      ],
      [
        { id: "d1", name: "Dr Amal" },
        { id: "d2", name: "Dr Zed" },
      ],
      days,
      "Asia/Dubai",
    );
    expect(rows.map((r) => r.name)).toEqual(["Dr Amal", "Dr Zed", "Other"]);
    expect(rows[0].cells[2].map((x) => x.id)).toEqual(["early", "late"]);
    expect(rows[0].count).toBe(2);
    expect(rows[1].cells[1].map((x) => x.id)).toEqual(["night"]);
    expect(rows[2].cells[3].map((x) => x.id)).toEqual(["stranger"]);
  });

  it("leaves out the Other row when everyone is known", () => {
    expect(
      weekGrid([], [{ id: "d1", name: "Dr Amal" }], weekDates("2026-10-14"), "UTC"),
    ).toHaveLength(1);
  });
});

describe("check-in chip in the diary", () => {
  it("has a label and a dark-mode pair for every state, and nothing for not arrived", () => {
    for (const s of CHECKIN_STATES) {
      expect(CHECKIN_CHIP[s].label.length).toBeGreaterThan(0);
      expect(CHECKIN_CHIP[s].className).toMatch(/dark:bg-/);
      expect(CHECKIN_CHIP[s].className).toMatch(/dark:text-/);
      expect(CHECKIN_CHIP[s].className).not.toMatch(/text-white/);
    }
    expect(checkinChip("with_doctor")?.label).toBe("With doctor");
    expect(checkinChip(null)).toBeNull();
    expect(checkinChip("teleported")).toBeNull();
  });
});
