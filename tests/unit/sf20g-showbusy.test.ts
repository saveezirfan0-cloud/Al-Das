/**
 * Phase 20g (G6) ShowBusy in the one pure slot engine: with `includeTaken` the refused slots inside working hours are
 * listed too, marked booked / blocked / full; without it (the default, and ShowBusy off) the list is exactly the old
 * free-slot list. The capacity rule itself is unchanged. Asia/Dubai (UTC+4), synthetic times only.
 */
import { describe, expect, it } from "vitest";

import {
  generateSlots,
  isSlotAvailable,
  slotFits,
  slotTakenReason,
  type BusyInterval,
  type SlotInput,
} from "@/lib/appointments/slots";
import {
  appointmentSettingsSchema,
  DEFAULT_APPOINTMENT_SETTINGS,
  readAppointmentSettings,
} from "@/lib/appointments/settings";

const DUBAI = "Asia/Dubai";
const MON = "2026-10-12"; // a Monday
const dubai = (hhmm: string) => new Date(`${MON}T${hhmm}:00+04:00`);
const booking = (from: string, to: string, extra: Partial<BusyInterval> = {}): BusyInterval => ({
  start: dubai(from),
  end: dubai(to),
  kind: "booking",
  ...extra,
});
const block = (from: string, to: string): BusyInterval => ({
  start: dubai(from),
  end: dubai(to),
  kind: "block",
});

function base(over: Partial<SlotInput> = {}): SlotInput {
  return {
    date: MON,
    timezone: DUBAI,
    durationMin: 30,
    granularityMin: 30,
    workingHours: [{ weekday: 1, start_min: 9 * 60, end_min: 12 * 60 }],
    busy: [],
    now: new Date("2026-10-01T00:00:00Z"),
    leadTimeMin: 0,
    ...over,
  };
}
const view = (input: SlotInput) =>
  generateSlots(input, { includeTaken: true }).map(
    (s) => `${s.label}${s.taken ? `:${s.taken}` : ""}`,
  );

describe("ShowBusy off is the old list exactly", () => {
  const input = base({
    busy: [booking("10:00", "10:30"), block("11:00", "11:30")],
    recurringBlocks: [{ weekday: 1, start_min: 11 * 60 + 30, end_min: 12 * 60 }],
  });

  it("default and includeTaken:false return only free slots, without a taken field", () => {
    const old = generateSlots(input);
    expect(old.map((s) => s.label)).toEqual(["09:00", "09:30", "10:30"]);
    expect(generateSlots(input, { includeTaken: false })).toEqual(old);
    expect(old.every((s) => !("taken" in s))).toBe(true);
  });

  it("the free slots of the ShowBusy list are the old list, in the same order", () => {
    const all = generateSlots(input, { includeTaken: true });
    expect(all.filter((s) => !s.taken)).toEqual(generateSlots(input));
  });

  it("isSlotAvailable still refuses a taken slot", () => {
    expect(isSlotAvailable(input, dubai("10:00"))).toBe(false);
    expect(isSlotAvailable(input, dubai("10:30"))).toBe(true);
  });
});

describe("taken slots carry the reason", () => {
  it("booked, blocked (one-off and weekly) and the free ones, in time order", () => {
    expect(
      view(
        base({
          busy: [booking("10:00", "10:30"), block("11:00", "11:30")],
          recurringBlocks: [{ weekday: 1, start_min: 11 * 60 + 30, end_min: 12 * 60 }],
        }),
      ),
    ).toEqual(["09:00", "09:30", "10:00:booked", "10:30", "11:00:blocked", "11:30:blocked"]);
  });

  it("a block wins over a booking in the same slot (SQL checks blocks first)", () => {
    expect(view(base({ busy: [booking("09:00", "09:30"), block("09:15", "09:45")] }))[0]).toBe(
      "09:00:blocked",
    );
  });

  it("a shared slot with every place taken is full; with a place left it is free", () => {
    const group = (n: number) =>
      Array.from({ length: n }, () => booking("09:00", "09:30", { capacity: 3 }));
    expect(view(base({ capacity: 3, busy: group(2) }))[0]).toBe("09:00");
    expect(view(base({ capacity: 3, busy: group(3) }))[0]).toBe("09:00:full");
  });

  it("a one-place service next to a group booking is booked (it cannot share)", () => {
    expect(view(base({ capacity: 1, busy: [booking("09:00", "09:30", { capacity: 3 })] }))[0]).toBe(
      "09:00:booked",
    );
  });

  it("buffers that reach a booking make the slot taken, with the booking's reason", () => {
    const input = base({ bufferAfterMin: 15, busy: [booking("09:30", "10:00")] });
    // 09:00 + 30 min + 15 min buffer reaches 09:30
    expect(view(input).slice(0, 3)).toEqual(["09:00:booked", "09:30:booked", "10:00"]);
  });

  it("an interval without a kind counts as a booking", () => {
    expect(
      slotTakenReason({ start: dubai("09:00"), end: dubai("09:30") }, [
        { start: dubai("09:00"), end: dubai("09:30") },
      ]),
    ).toBe("booked");
  });

  it("slotTakenReason is null exactly when slotFits is true", () => {
    const busy = [booking("09:00", "09:45", { capacity: 2 }), block("10:30", "11:00")];
    for (let m = 0; m < 180; m += 5) {
      const start = new Date(dubai("09:00").getTime() + m * 60_000);
      const c = { start, end: new Date(start.getTime() + 30 * 60_000), capacity: 2 };
      expect(slotTakenReason(c, busy) === null).toBe(slotFits(c, busy));
    }
  });
});

describe("what ShowBusy never lists", () => {
  it("closed days, holidays, the lead time and times outside working hours", () => {
    expect(generateSlots(base({ holidays: [MON] }), { includeTaken: true })).toEqual([]);
    expect(generateSlots(base({ workingWeekdays: [2, 3] }), { includeTaken: true })).toEqual([]);
    const late = base({ now: dubai("10:10"), busy: [booking("11:00", "11:30")] });
    expect(view(late)).toEqual(["10:30", "11:00:booked", "11:30"]);
  });
});

describe("the show_busy booking setting", () => {
  it("is off by default and on old stored settings", () => {
    expect(DEFAULT_APPOINTMENT_SETTINGS.show_busy).toBe(false);
    expect(readAppointmentSettings({ appointments: { auto_confirm: true } }).show_busy).toBe(false);
    expect(appointmentSettingsSchema.parse({ show_busy: true }).show_busy).toBe(true);
  });
});
