import { describe, expect, it } from "vitest";

import {
  generateSlots,
  isOpenDay,
  isoWeekday,
  isSlotAvailable,
  localDate,
  localMinutesToInstant,
  workingWindows,
  type SlotInput,
} from "@/lib/appointments/slots";

const DUBAI = "Asia/Dubai"; // UTC+4, no DST
const NY = "America/New_York"; // DST: 2026-03-08 spring forward, 2026-11-01 fall back

// 2026-10-12 is a Monday.
const mondayHours = [{ weekday: 1, start_min: 9 * 60, end_min: 12 * 60 }];

function base(over: Partial<SlotInput> = {}): SlotInput {
  return {
    date: "2026-10-12",
    timezone: DUBAI,
    durationMin: 30,
    granularityMin: 30,
    workingHours: mondayHours,
    busy: [],
    now: new Date("2026-10-01T00:00:00Z"),
    leadTimeMin: 0,
    ...over,
  };
}

describe("calendar helpers", () => {
  it("computes ISO weekdays", () => {
    expect(isoWeekday("2026-10-12")).toBe(1); // Monday
    expect(isoWeekday("2026-10-18")).toBe(7); // Sunday
  });

  it("converts an instant to the local date in the location timezone", () => {
    // 21:30Z on the 11th is already 01:30 on the 12th in Dubai.
    expect(localDate(new Date("2026-10-11T21:30:00Z"), DUBAI)).toBe("2026-10-12");
    expect(localDate(new Date("2026-10-11T21:30:00Z"), NY)).toBe("2026-10-11");
  });

  it("maps wall-clock minutes to instants, including end of day", () => {
    expect(localMinutesToInstant("2026-10-12", 9 * 60, DUBAI).toISOString()).toBe(
      "2026-10-12T05:00:00.000Z",
    );
    expect(localMinutesToInstant("2026-10-12", 1440, DUBAI).toISOString()).toBe(
      "2026-10-12T20:00:00.000Z",
    );
  });

  it("knows open days and holidays", () => {
    expect(isOpenDay("2026-10-12")).toBe(true);
    expect(isOpenDay("2026-10-18")).toBe(false); // Sunday, default Mon–Sat
    expect(isOpenDay("2026-10-12", [1, 2, 3], ["2026-10-12"])).toBe(false);
  });
});

describe("generateSlots", () => {
  it("lists slots inside working hours in the location timezone", () => {
    const slots = generateSlots(base());
    expect(slots.map((s) => s.label)).toEqual([
      "09:00",
      "09:30",
      "10:00",
      "10:30",
      "11:00",
      "11:30",
    ]);
    expect(slots[0].start.toISOString()).toBe("2026-10-12T05:00:00.000Z");
    expect(slots[5].end.toISOString()).toBe("2026-10-12T08:00:00.000Z");
  });

  it("does not overrun the end of the window", () => {
    const slots = generateSlots(base({ durationMin: 45, granularityMin: 15 }));
    expect(slots.at(-1)?.label).toBe("11:15"); // 11:15 + 45 = 12:00
  });

  it("returns nothing on a non-working weekday or a holiday", () => {
    expect(generateSlots(base({ date: "2026-10-13" }))).toEqual([]); // no Tuesday hours
    expect(generateSlots(base({ holidays: ["2026-10-12"] }))).toEqual([]);
    expect(generateSlots(base({ workingWeekdays: [2, 3] }))).toEqual([]);
  });

  it("blocks slots that overlap appointments and time blocks", () => {
    const slots = generateSlots(
      base({
        busy: [
          // 09:30–10:15 local = 05:30–06:15Z blocks the 09:30, 10:00 slots
          { start: new Date("2026-10-12T05:30:00Z"), end: new Date("2026-10-12T06:15:00Z") },
        ],
      }),
    );
    expect(slots.map((s) => s.label)).toEqual(["09:00", "10:30", "11:00", "11:30"]);
  });

  it("allows back-to-back bookings (touching intervals do not overlap)", () => {
    const slots = generateSlots(
      base({
        busy: [{ start: new Date("2026-10-12T05:00:00Z"), end: new Date("2026-10-12T05:30:00Z") }],
      }),
    );
    expect(slots[0].label).toBe("09:30");
  });

  it("respects lead time", () => {
    // now = 08:50 local (04:50Z), lead 30 min → earliest 09:20 → first slot 09:30
    const slots = generateSlots(base({ now: new Date("2026-10-12T04:50:00Z"), leadTimeMin: 30 }));
    expect(slots[0].label).toBe("09:30");
  });

  it("merges split shifts and removes duplicates from overlapping rows", () => {
    const slots = generateSlots(
      base({
        workingHours: [
          { weekday: 1, start_min: 9 * 60, end_min: 10 * 60 },
          { weekday: 1, start_min: 9 * 60 + 30, end_min: 10 * 60 + 30 },
          { weekday: 1, start_min: 14 * 60, end_min: 15 * 60 },
        ],
      }),
    );
    expect(slots.map((s) => s.label)).toEqual(["09:00", "09:30", "10:00", "14:00", "14:30"]);
  });

  it("ignores inverted or zero-length rows and bad durations", () => {
    expect(
      generateSlots(base({ workingHours: [{ weekday: 1, start_min: 600, end_min: 600 }] })),
    ).toEqual([]);
    expect(generateSlots(base({ durationMin: 0 }))).toEqual([]);
    expect(generateSlots(base({ granularityMin: 0 }))).toEqual([]);
  });

  it("keeps wall-clock hours across a DST change (spring forward, New York)", () => {
    const hours = [{ weekday: 7, start_min: 9 * 60, end_min: 10 * 60 }]; // Sunday
    const before = generateSlots({
      ...base({
        timezone: NY,
        workingHours: hours,
        workingWeekdays: [7],
        now: new Date("2026-01-01T00:00:00Z"),
      }),
      date: "2026-03-01", // EST, UTC-5
    });
    const after = generateSlots({
      ...base({
        timezone: NY,
        workingHours: hours,
        workingWeekdays: [7],
        now: new Date("2026-01-01T00:00:00Z"),
      }),
      date: "2026-03-08", // DST starts at 02:00 → EDT, UTC-4
    });
    expect(before[0].start.toISOString()).toBe("2026-03-01T14:00:00.000Z");
    expect(after[0].start.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(after[0].label).toBe("09:00");
  });

  it("handles fall back (New York) with correct UTC offsets", () => {
    const hours = [{ weekday: 7, start_min: 9 * 60, end_min: 10 * 60 }];
    const slots = generateSlots({
      ...base({
        timezone: NY,
        workingHours: hours,
        workingWeekdays: [7],
        now: new Date("2026-01-01T00:00:00Z"),
      }),
      date: "2026-11-01", // DST ends at 02:00 → EST, UTC-5
    });
    expect(slots[0].start.toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });

  it("treats the same wall-clock hours as different instants in different zones", () => {
    const dubai = generateSlots(base())[0].start.getTime();
    const ny = generateSlots(base({ timezone: NY }))[0].start.getTime();
    expect(ny - dubai).toBe(8 * 3600_000); // 09:00 EDT (UTC-4) vs 09:00 +04
  });
});

describe("isSlotAvailable / workingWindows", () => {
  it("accepts a generated slot and rejects an off-grid or busy start", () => {
    const input = base();
    expect(isSlotAvailable(input, new Date("2026-10-12T05:00:00Z"))).toBe(true);
    expect(isSlotAvailable(input, new Date("2026-10-12T05:10:00Z"))).toBe(false);
    expect(isSlotAvailable(input, new Date("2026-10-12T09:00:00Z"))).toBe(false); // after hours
  });

  it("returns shaded windows as instants, sorted", () => {
    const w = workingWindows("2026-10-12", DUBAI, [
      { weekday: 1, start_min: 14 * 60, end_min: 16 * 60 },
      { weekday: 1, start_min: 9 * 60, end_min: 12 * 60 },
    ]);
    expect(w.map((x) => x.start.toISOString())).toEqual([
      "2026-10-12T05:00:00.000Z",
      "2026-10-12T10:00:00.000Z",
    ]);
    expect(workingWindows("2026-10-12", DUBAI, mondayHours, [2], [])).toEqual([]);
  });
});
