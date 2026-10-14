import { describe, expect, it } from "vitest";

import {
  availableMinutes,
  monthDates,
  monthRange,
  openDates,
  subtractIntervals,
  unionIntervals,
} from "@/lib/capacity/hours";

const TZ = "Asia/Dubai";
// September 2026: 1 Sep is a Tuesday; 30 days; Mon-Sat open = 26 days.
const MONTH = "2026-09-01";
const MON_SAT = [1, 2, 3, 4, 5, 6];
const at = (iso: string) => new Date(`${iso}+04:00`);
const weekdaysEveryDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
  weekday,
  start_min: 540, // 09:00
  end_min: 1020, // 17:00
}));

describe("month and open days", () => {
  it("lists every date of the month, leap years included", () => {
    expect(monthDates(MONTH)).toHaveLength(30);
    expect(monthDates("2028-02-01")).toHaveLength(29);
    expect(monthDates("2026-02-01").at(-1)).toBe("2026-02-28");
    expect(monthDates("garbage")).toEqual([]);
  });

  it("follows the slot engine's working week and holidays", () => {
    expect(openDates(MONTH, MON_SAT)).toHaveLength(26);
    expect(openDates(MONTH, MON_SAT, ["2026-09-01", "2026-09-06"])).toHaveLength(25); // 6 Sep is a Sunday
  });

  it("gives a range wide enough for blocks in any timezone", () => {
    expect(monthRange(MONTH)).toEqual({ from: "2026-08-31T00:00:00Z", to: "2026-10-02T00:00:00Z" });
  });
});

describe("interval maths", () => {
  it("merges overlapping and touching intervals", () => {
    expect(
      unionIntervals([
        { start: 5, end: 8 },
        { start: 0, end: 3 },
        { start: 3, end: 4 },
        { start: 7, end: 10 },
        { start: 12, end: 12 },
      ]),
    ).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 10 },
    ]);
  });

  it("cuts overlapping blocks once, never twice", () => {
    expect(
      subtractIntervals(
        [{ start: 0, end: 100 }],
        [
          { start: 10, end: 30 },
          { start: 20, end: 40 },
          { start: 90, end: 120 },
        ],
      ),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 90 },
    ]);
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: -5, end: 50 }])).toEqual([]);
  });
});

describe("available hours", () => {
  const base = { month: MONTH, workingWeekdays: MON_SAT };

  it("counts working hours on open days only", () => {
    const m = availableMinutes({
      ...base,
      locations: [
        { timezone: TZ, workingHours: weekdaysEveryDay, recurringBlocks: [], timeBlocks: [] },
      ],
    });
    expect(m / 60).toBe(26 * 8);
  });

  it("subtracts holidays, weekly blocks and leave, and an overlap between them only once", () => {
    const m = availableMinutes({
      ...base,
      holidays: ["2026-09-01"], // a Tuesday: the whole day goes
      locations: [
        {
          timezone: TZ,
          workingHours: weekdaysEveryDay,
          // lunch 13:00-14:00 every weekday
          recurringBlocks: MON_SAT.map((weekday) => ({ weekday, start_min: 780, end_min: 840 })),
          timeBlocks: [
            // leave: all of Wed 2 Sep and Thu 3 Sep
            { start: at("2026-09-02T00:00:00"), end: at("2026-09-04T00:00:00") },
            // a meeting overlapping lunch on Fri 4 Sep, 12:30-14:30: only 1 h extra beyond lunch
            { start: at("2026-09-04T12:30:00"), end: at("2026-09-04T14:30:00") },
          ],
        },
      ],
    });
    // 26 open days - 1 holiday = 25; minus 2 days of leave = 23 days at 7 h, minus 1 h on 4 Sep
    expect(m / 60).toBe(23 * 7 - 1);
  });

  it("ignores blocks outside the working windows and on closed days", () => {
    const m = availableMinutes({
      ...base,
      locations: [
        {
          timezone: TZ,
          workingHours: [{ weekday: 1, start_min: 540, end_min: 600 }],
          recurringBlocks: [{ weekday: 7, start_min: 0, end_min: 1440 }],
          timeBlocks: [{ start: at("2026-09-08T18:00:00"), end: at("2026-09-08T20:00:00") }],
        },
      ],
    });
    expect(m).toBe(4 * 60); // four Mondays in Sep 2026, one hour each
  });

  it("merges overlapping rows and two branches at the same moment", () => {
    const one = { weekday: 1, start_min: 540, end_min: 720 };
    const m = availableMinutes({
      ...base,
      locations: [
        {
          timezone: TZ,
          workingHours: [one, { weekday: 1, start_min: 660, end_min: 780 }],
          recurringBlocks: [],
          timeBlocks: [],
        },
        { timezone: TZ, workingHours: [one], recurringBlocks: [], timeBlocks: [] },
      ],
    });
    expect(m).toBe(4 * 240); // 09:00-13:00 on four Mondays, counted once
  });

  it("is zero with no working hours", () => {
    expect(availableMinutes({ ...base, locations: [] })).toBe(0);
  });
});
