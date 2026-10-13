/**
 * Phase 20c (G6) booking capacity in the one pure slot engine: buffers (also across midnight), concurrent
 * patients / bookings per slot, weekly (recurring) blocks, per-specialist slot length, holidays and lead time,
 * in Asia/Dubai (UTC+4, no DST). Defaults must reproduce the old behaviour exactly. Synthetic times only.
 */
import { describe, expect, it } from "vitest";

import {
  expandRecurringBlocks,
  generateSlots,
  isSlotAvailable,
  slotFits,
  type BusyInterval,
  type SlotInput,
} from "@/lib/appointments/slots";

const DUBAI = "Asia/Dubai";
// 2026-10-12 is a Monday; Dubai local = UTC + 4h.
const MON = "2026-10-12";
const at = (iso: string) => new Date(iso);
/** Local Dubai "HH:mm" on a date → instant. */
const dubai = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+04:00`);
const labels = (input: SlotInput) => generateSlots(input).map((s) => s.label);

function base(over: Partial<SlotInput> = {}): SlotInput {
  return {
    date: MON,
    timezone: DUBAI,
    durationMin: 30,
    granularityMin: 30,
    workingHours: [{ weekday: 1, start_min: 9 * 60, end_min: 12 * 60 }],
    busy: [],
    now: at("2026-10-01T00:00:00Z"),
    leadTimeMin: 0,
    ...over,
  };
}

const appt = (date: string, from: string, to: string, extra: Partial<BusyInterval> = {}) => ({
  start: dubai(date, from),
  end: dubai(date, to),
  ...extra,
});

describe("defaults reproduce the old rule", () => {
  it("any overlap refuses, back-to-back is fine, blocks refuse", () => {
    const busy = [appt(MON, "10:00", "10:30"), appt(MON, "11:15", "11:45")];
    expect(labels(base({ busy }))).toEqual(["09:00", "09:30", "10:30"]);
    // explicit capacity 1 / zero buffers are the same thing
    expect(
      labels(
        base({
          busy: busy.map((b) => ({ ...b, capacity: 1, bufferBeforeMin: 0, bufferAfterMin: 0 })),
          capacity: 1,
          bufferBeforeMin: 0,
          bufferAfterMin: 0,
          recurringBlocks: [],
        }),
      ),
    ).toEqual(["09:00", "09:30", "10:30"]);
  });

  it("slotFits mirrors the rule on single intervals", () => {
    const busy = [appt(MON, "10:00", "10:30")];
    expect(slotFits({ start: dubai(MON, "10:30"), end: dubai(MON, "11:00") }, busy)).toBe(true);
    expect(slotFits({ start: dubai(MON, "10:29"), end: dubai(MON, "10:59") }, busy)).toBe(false);
    expect(slotFits({ start: dubai(MON, "09:30"), end: dubai(MON, "10:00") }, busy)).toBe(true);
  });
});

describe("buffers", () => {
  it("keeps the candidate's buffers clear of other bookings", () => {
    const busy = [appt(MON, "10:00", "10:30")];
    // 15 after: 09:30–10:00 would need until 10:15. 15 before: 10:30 would need from 10:15.
    expect(labels(base({ busy, bufferAfterMin: 15 }))).toEqual([
      "09:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(labels(base({ busy, bufferBeforeMin: 15 }))).toEqual([
      "09:00",
      "09:30",
      "11:00",
      "11:30",
    ]);
  });

  it("respects the existing booking's own buffers, and both buffers add up", () => {
    const busy = [appt(MON, "10:00", "10:30", { bufferAfterMin: 15 })];
    const s = base({ busy, granularityMin: 15 });
    expect(isSlotAvailable(s, dubai(MON, "10:30"))).toBe(false); // inside their cleaning time
    expect(isSlotAvailable(s, dubai(MON, "10:45"))).toBe(true);
    const both = base({ busy, granularityMin: 15, bufferBeforeMin: 15 });
    expect(isSlotAvailable(both, dubai(MON, "10:45"))).toBe(false);
    expect(isSlotAvailable(both, dubai(MON, "11:00"))).toBe(true); // exact edge: 10:45 = 10:45
  });

  it("applies buffers to one-off blocks but not to the edges of working hours", () => {
    const block = { start: dubai(MON, "11:00"), end: dubai(MON, "12:00") };
    const s = base({ busy: [block], bufferBeforeMin: 10, bufferAfterMin: 10 });
    expect(labels(s)).toEqual(["09:00", "09:30", "10:00"]); // 10:30 would clean until 11:10
    // the first slot of the day starts at 09:00 even though its preparation is before opening
    expect(labels(base({ bufferBeforeMin: 30 }))[0]).toBe("09:00");
  });

  it("reaches across midnight in both directions", () => {
    const allDay = (wd: number) => [{ weekday: wd, start_min: 0, end_min: 1440 }];
    // Previous evening (Sunday) booking 23:30–24:00 with 30 minutes of cleaning blocks Monday 00:00.
    const sunday = appt("2026-10-11", "23:30", "23:59", {
      end: dubai(MON, "00:00"),
      bufferAfterMin: 30,
    });
    const mon = labels(base({ workingHours: allDay(1), busy: [sunday] }));
    expect(mon[0]).toBe("00:30");
    expect(mon).not.toContain("00:00");
    // A Tuesday 00:00–01:00 weekly block refuses Monday 23:30 when the service needs 15 minutes after.
    const s = base({
      workingHours: allDay(1),
      bufferAfterMin: 15,
      recurringBlocks: [{ weekday: 2, start_min: 0, end_min: 60 }],
    });
    expect(labels(s)).not.toContain("23:30");
    expect(labels(s)).toContain("23:00");
    expect(labels({ ...s, bufferAfterMin: 0 })).toContain("23:30");
  });
});

describe("capacity (concurrent patients and bookings per slot)", () => {
  it("offers a slot until the last place is taken", () => {
    const group = (n: number) =>
      Array.from({ length: n }, () => appt(MON, "10:00", "10:30", { capacity: 3 }));
    expect(labels(base({ busy: group(2), capacity: 3 }))).toContain("10:00");
    expect(labels(base({ busy: group(3), capacity: 3 }))).not.toContain("10:00");
  });

  it("uses the smallest number of places among everyone overlapping", () => {
    // A one-patient consultation never shares, whichever side has the bigger number.
    expect(
      labels(base({ busy: [appt(MON, "10:00", "10:30", { capacity: 1 })], capacity: 3 })),
    ).not.toContain("10:00");
    expect(
      labels(base({ busy: [appt(MON, "10:00", "10:30", { capacity: 3 })], capacity: 1 })),
    ).not.toContain("10:00");
    // Two different 2-place bookings partly overlapping still count as two.
    const busy = [
      appt(MON, "10:00", "10:30", { capacity: 2 }),
      appt(MON, "10:15", "10:45", { capacity: 2 }),
    ];
    expect(
      slotFits({ start: dubai(MON, "10:00"), end: dubai(MON, "10:30"), capacity: 2 }, busy),
    ).toBe(false);
  });

  it("never lets a block be shared, whatever the capacity", () => {
    const block = { start: dubai(MON, "10:00"), end: dubai(MON, "10:30") };
    expect(labels(base({ busy: [block], capacity: 10 }))).not.toContain("10:00");
  });

  it("counts buffers when deciding who overlaps", () => {
    const busy = [appt(MON, "10:00", "10:30", { capacity: 2, bufferAfterMin: 15 })];
    const s = base({ busy, capacity: 2, granularityMin: 15 });
    // one place left at 10:00 and 10:15 (they overlap one booking); 10:30 also overlaps its cleaning
    expect(isSlotAvailable(s, dubai(MON, "10:00"))).toBe(true);
    expect(isSlotAvailable(s, dubai(MON, "10:30"))).toBe(true);
    const full = base({ busy: [...busy, ...busy], capacity: 2, granularityMin: 15 });
    expect(isSlotAvailable(full, dubai(MON, "10:30"))).toBe(false);
    expect(isSlotAvailable(full, dubai(MON, "10:45"))).toBe(true);
  });
});

describe("weekly (recurring) blocks", () => {
  const lunch = [{ weekday: 1, start_min: 13 * 60, end_min: 14 * 60 }];
  const day = [{ weekday: 1, start_min: 12 * 60, end_min: 15 * 60 }];

  it("removes the block's slots on its weekday only", () => {
    expect(labels(base({ workingHours: day, recurringBlocks: lunch }))).toEqual([
      "12:00",
      "12:30",
      "14:00",
      "14:30",
    ]);
    const tuesday = base({
      date: "2026-10-13",
      workingHours: [{ weekday: 2, start_min: 12 * 60, end_min: 15 * 60 }],
      recurringBlocks: lunch,
    });
    expect(labels(tuesday)).toHaveLength(6);
  });

  it("is wall-clock in Asia/Dubai all year (no DST)", () => {
    for (const date of ["2026-01-05", "2026-07-06", "2026-10-12"]) {
      const [b] = expandRecurringBlocks(lunch, date, date, DUBAI);
      expect(b.start.toISOString()).toBe(`${date}T09:00:00.000Z`);
      expect(b.end.toISOString()).toBe(`${date}T10:00:00.000Z`);
    }
    // end of day = next midnight
    const [late] = expandRecurringBlocks(
      [{ weekday: 1, start_min: 1380, end_min: 1440 }],
      MON,
      MON,
      DUBAI,
    );
    expect(late.end.toISOString()).toBe("2026-10-12T20:00:00.000Z");
  });

  it("keeps buffers clear of the weekly block", () => {
    const s = base({ workingHours: day, recurringBlocks: lunch, bufferBeforeMin: 15 });
    expect(labels(s)).toEqual(["12:00", "12:30", "14:30"]); // 14:00 would prepare during lunch
  });
});

describe("slot length, holidays and lead time still apply", () => {
  it("steps by the specialist's slot length", () => {
    expect(labels(base({ granularityMin: 20, durationMin: 20 })).slice(0, 4)).toEqual([
      "09:00",
      "09:20",
      "09:40",
      "10:00",
    ]);
  });

  it("offers nothing on a holiday or a closed weekday, whatever the capacity", () => {
    expect(generateSlots(base({ holidays: [MON], capacity: 5 }))).toEqual([]);
    expect(generateSlots(base({ workingWeekdays: [2, 3], capacity: 5 }))).toEqual([]);
  });

  it("hides slots inside the lead time but not those after it", () => {
    const s = base({ now: dubai(MON, "09:10"), leadTimeMin: 30, capacity: 3 });
    expect(labels(s)[0]).toBe("10:00");
  });
});
