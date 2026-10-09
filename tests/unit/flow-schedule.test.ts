import { describe, expect, it } from "vitest";

import { cronFromForm, describeSchedule, formFromCron } from "@/lib/flow-engine/schedule";

describe("recurring schedule builder", () => {
  it("builds cron for daily / weekly / monthly", () => {
    expect(cronFromForm({ freq: "daily", time: "09:05" })).toBe("5 9 * * *");
    expect(cronFromForm({ freq: "weekly", time: "18:00", weekday: 1 })).toBe("0 18 * * 1");
    expect(cronFromForm({ freq: "monthly", time: "08:30", day: 15 })).toBe("30 8 15 * *");
  });
  it("rejects bad input", () => {
    expect(cronFromForm({ freq: "daily", time: "9am" })).toBeNull();
    expect(cronFromForm({ freq: "weekly", time: "09:00", weekday: 7 })).toBeNull();
    expect(cronFromForm({ freq: "monthly", time: "09:00", day: 31 })).toBeNull();
    expect(cronFromForm({ freq: "custom", cron: "nope" })).toBeNull();
    expect(cronFromForm({ freq: "custom", cron: "*/10 * * * *" })).toBe("*/10 * * * *");
  });
  it("round-trips through formFromCron", () => {
    for (const f of [
      { freq: "daily", time: "09:05" },
      { freq: "weekly", time: "18:00", weekday: 0 },
      { freq: "monthly", time: "08:30", day: 28 },
    ] as const) {
      expect(formFromCron(cronFromForm(f)!)).toEqual(f);
    }
    expect(formFromCron("*/10 * * * *")).toEqual({ freq: "custom", cron: "*/10 * * * *" });
    expect(formFromCron(undefined)).toEqual({ freq: "daily", time: "09:00" });
    expect(formFromCron("0 9 31 * *")).toEqual({ freq: "custom", cron: "0 9 31 * *" });
  });
  it("describes schedules", () => {
    expect(describeSchedule({ freq: "weekly", time: "09:00", weekday: 1 })).toBe(
      "Every Monday at 09:00",
    );
  });
});
