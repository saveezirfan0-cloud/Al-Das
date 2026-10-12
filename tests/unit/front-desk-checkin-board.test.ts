import { describe, expect, it } from "vitest";

import {
  boardSection,
  confirmation,
  groupByHour,
  reminderHint,
  summariseBoard,
  waitingMinutes,
  type BoardAppointment,
} from "@/lib/front-desk/board";
import {
  canMoveCheckin,
  checkinPatch,
  isCheckinState,
  minutesBetween,
  nextCheckinState,
} from "@/lib/front-desk/checkin";

const now = new Date("2026-10-14T09:00:00Z");
const row = (over: Partial<BoardAppointment> = {}): BoardAppointment => ({
  id: "a",
  number: 1,
  starts_at: "2026-10-14T09:30:00Z",
  ends_at: "2026-10-14T10:00:00Z",
  status: "awaiting",
  checkin_status: null,
  arrived_at: null,
  is_walk_in: false,
  source: "portal",
  contact_id: "c",
  specialist_id: "s",
  reminder: null,
  ...over,
});

describe("check-in states", () => {
  it("steps Arrived, With doctor, Done, Checked out in order", () => {
    expect(nextCheckinState(null)).toBe("arrived");
    expect(nextCheckinState("arrived")).toBe("with_doctor");
    expect(nextCheckinState("with_doctor")).toBe("done");
    expect(nextCheckinState("done")).toBe("checked_out");
    expect(nextCheckinState("checked_out")).toBeNull();
  });

  it("allows forward moves (also skipping a step) and exactly one step back", () => {
    expect(canMoveCheckin(null, "arrived").ok).toBe(true);
    expect(canMoveCheckin("arrived", "done").ok).toBe(true);
    expect(canMoveCheckin("done", "with_doctor").ok).toBe(true);
    expect(canMoveCheckin("arrived", null).ok).toBe(true); // undo a mis-tap
    expect(canMoveCheckin("done", "arrived").ok).toBe(false); // two steps back
    expect(canMoveCheckin("done", "done").ok).toBe(false);
    expect(canMoveCheckin(null, null).ok).toBe(false);
  });

  it("stamps the time of the state reached and clears the one left", () => {
    const t = new Date("2026-10-14T09:05:00Z");
    expect(checkinPatch(null, "arrived", t)).toEqual({
      checkin_status: "arrived",
      arrived_at: t.toISOString(),
    });
    expect(checkinPatch("arrived", "with_doctor", t)).toMatchObject({
      with_doctor_at: t.toISOString(),
    });
    expect(checkinPatch("with_doctor", "arrived", t)).toEqual({
      checkin_status: "arrived",
      with_doctor_at: null,
    });
    expect(checkinPatch("arrived", null, t)).toEqual({ checkin_status: null, arrived_at: null });
    expect(checkinPatch("done", "arrived", t)).toBeNull();
  });

  it("recognises only the four states", () => {
    expect(isCheckinState("arrived")).toBe(true);
    expect(isCheckinState("seen")).toBe(false);
    expect(isCheckinState(null)).toBe(false);
  });

  it("measures minutes between two times", () => {
    expect(minutesBetween("2026-10-14T09:00:00Z", "2026-10-14T09:25:30Z")).toBe(25);
    expect(minutesBetween(null, "2026-10-14T09:25:30Z")).toBeNull();
  });
});

describe("board classification", () => {
  it("puts people in the right section", () => {
    expect(boardSection(row(), now)).toBe("expected");
    expect(boardSection(row({ starts_at: "2026-10-14T08:00:00Z" }), now)).toBe("late");
    expect(boardSection(row({ starts_at: "2026-10-14T08:50:00Z" }), now)).toBe("expected"); // inside the grace
    expect(boardSection(row({ checkin_status: "arrived" }), now)).toBe("waiting");
    expect(boardSection(row({ checkin_status: "with_doctor" }), now)).toBe("with_doctor");
    expect(boardSection(row({ checkin_status: "done" }), now)).toBe("done");
    expect(boardSection(row({ checkin_status: "checked_out" }), now)).toBe("checked_out");
    expect(boardSection(row({ status: "no_show" }), now)).toBe("no_show");
    expect(boardSection(row({ status: "cancelled" }), now)).toBe("cancelled");
    // completed in the EMR with nobody tapping through the desk states
    expect(boardSection(row({ status: "completed", starts_at: "2026-10-14T07:00:00Z" }), now)).toBe(
      "done",
    );
  });

  it("reads confirmed vs unconfirmed from the appointment status (set by the patient's Confirm tap)", () => {
    expect(confirmation({ status: "confirmed" })).toBe("confirmed");
    expect(confirmation({ status: "awaiting" })).toBe("unconfirmed");
  });

  it("tells the desk whether to ring an unconfirmed patient", () => {
    expect(reminderHint({ status: "confirmed", reminder: null })).toBe("none");
    expect(reminderHint({ status: "awaiting", reminder: "failed" })).toBe("call");
    expect(reminderHint({ status: "awaiting", reminder: "sent" })).toBe("waiting_reply");
    expect(reminderHint({ status: "awaiting", reminder: "scheduled" })).toBe("not_sent_yet");
    expect(reminderHint({ status: "awaiting", reminder: null })).toBe("call");
  });

  it("summarises the day", () => {
    const rows = [
      row({ id: "1", status: "confirmed" }),
      row({ id: "2" }),
      row({ id: "3", starts_at: "2026-10-14T08:00:00Z" }),
      row({ id: "4", checkin_status: "arrived", arrived_at: "2026-10-14T08:40:00Z" }),
      row({ id: "5", checkin_status: "with_doctor" }),
      row({ id: "6", checkin_status: "checked_out" }),
      row({ id: "7", status: "no_show" }),
      row({ id: "8", status: "cancelled" }),
      row({ id: "9", is_walk_in: true, checkin_status: "arrived" }),
    ];
    expect(summariseBoard(rows, now)).toEqual({
      expected: 2,
      waiting: 2,
      withDoctor: 1,
      done: 0,
      checkedOut: 1,
      late: 1,
      noShow: 1,
      cancelled: 1,
      walkIns: 1,
      confirmed: 1,
      unconfirmed: 2,
      total: 8,
    });
  });

  it("groups by local hour in the clinic timezone", () => {
    const groups = groupByHour(
      [
        row({ id: "x", starts_at: "2026-10-14T05:30:00Z" }),
        row({ id: "y", starts_at: "2026-10-14T05:50:00Z" }),
        row({ id: "z", starts_at: "2026-10-14T06:10:00Z" }),
      ],
      "Asia/Dubai",
    );
    expect(groups.map((g) => [g.hour, g.rows.length])).toEqual([
      ["09:00", 2],
      ["10:00", 1],
    ]);
  });

  it("counts how long an arrived patient has waited", () => {
    expect(
      waitingMinutes({ checkin_status: "arrived", arrived_at: "2026-10-14T08:40:00Z" }, now),
    ).toBe(20);
    expect(
      waitingMinutes({ checkin_status: "with_doctor", arrived_at: "2026-10-14T08:40:00Z" }, now),
    ).toBeNull();
  });
});
