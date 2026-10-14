import { describe, expect, it } from "vitest";

import {
  buildCapacityReport,
  revenueByDoctor,
  splitByWeight,
  type CapacityInputs,
} from "@/lib/capacity/measures";

const rota = (entries: [string, string, number][]) => {
  const m = new Map<string, Map<string, number>>();
  for (const [room, doctor, minutes] of entries) {
    const r = m.get(room) ?? new Map<string, number>();
    r.set(doctor, minutes);
    m.set(room, r);
  }
  return m;
};

const base: CapacityInputs = {
  openDays: 20,
  openHoursPerDay: 10,
  revenueAvailable: true,
  doctors: [
    { specialistId: "d1", name: "Dr Alpha Demo", availableMinutes: 100 * 60, revenue: 10_000.001 },
    { specialistId: "d2", name: "Dr Beta Demo", availableMinutes: 50 * 60, revenue: 3_000 },
    { specialistId: "d3", name: "Dr Gamma Demo", availableMinutes: 0, revenue: 999.5 },
    { specialistId: "d4", name: "Dr Delta Demo", availableMinutes: 40 * 60, revenue: null },
  ],
  rooms: [
    { id: "r1", name: "Room 1", locationName: "North", kind: "consultation", monthlyCost: 6_000 },
    { id: "r2", name: "Room 2", locationName: "North", kind: "procedure", monthlyCost: null },
    { id: "r3", name: "Room 3", locationName: "North", kind: "dental", monthlyCost: 0 },
  ],
  rota: rota([
    ["r1", "d1", 40 * 60],
    ["r2", "d1", 20 * 60],
    ["r2", "d2", 30 * 60],
    ["r3", "d4", 10 * 60],
  ]),
};

describe("splitByWeight", () => {
  it("always adds up to the total, also for awkward thirds and negatives", () => {
    for (const [total, weights] of [
      [1000, [1, 1, 1]],
      [1, [1, 1, 1]],
      [-1000, [1, 2]],
      [10_000_001, [40, 20]],
      [7, [0, 3, 0, 5]],
    ] as [number, number[]][]) {
      const parts = splitByWeight(total, weights);
      expect(
        parts.reduce((s, p) => s + p, 0),
        String(weights),
      ).toBe(total);
      weights.forEach((w, i) => w === 0 && expect(parts[i]).toBe(0));
    }
    expect(splitByWeight(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(splitByWeight(500, [0, 0])).toEqual([0, 0]);
  });
});

describe("buildCapacityReport", () => {
  const r = buildCapacityReport(base);
  const room = (id: string) => r.rooms.find((x) => x.id === id)!;
  const doctor = (id: string) => r.doctors.find((x) => x.specialistId === id)!;

  it("attributes each doctor's revenue to rooms by rota share, adding up exactly", () => {
    // d1: 40 h in r1, 20 h in r2 -> 2/3 and 1/3 of 10,000.001 (the odd thousandth goes to the larger remainder,
    // r2's 0.67); d2 all in r2
    expect(room("r1").revenue).toBe(6666.667);
    expect(room("r2").revenue).toBe(6333.334);
    const attributed = r.rooms.reduce((s, x) => s + (x.revenue ?? 0), 0);
    expect(Math.round(attributed * 1000)).toBe(Math.round((10_000.001 + 3000) * 1000));
    expect(r.totals.attributedRevenue).toBe(13_000.001);
  });

  it("keeps the revenue of a doctor with no rota unattributed instead of spreading it", () => {
    expect(r.totals.unattributedRevenue).toBe(999.5);
    expect(r.totals.revenue).toBe(13_999.501);
  });

  it("revenue per available hour; unknown when there are no hours or no link", () => {
    expect(doctor("d1").revenuePerAvailableHour).toBe(100);
    expect(doctor("d2").revenuePerAvailableHour).toBe(60);
    expect(doctor("d3").revenuePerAvailableHour).toBeNull();
    expect(doctor("d4").revenue).toBeNull();
    expect(doctor("d4").revenuePerAvailableHour).toBeNull();
    expect(doctor("d1").rotaHours).toBe(60);
  });

  it("occupancy is rota hours over open hours; revenue per room-hour", () => {
    expect(room("r1").openHours).toBe(200);
    expect(room("r1").occupancy).toBe(0.2);
    expect(room("r2").rotaHours).toBe(50);
    expect(room("r2").revenuePerRoomHour).toBe(126.67);
  });

  it("an unknown cost stays unknown and a 0 cost is never used as a number", () => {
    expect(room("r1").costPerRotaHour).toBe(150);
    expect(room("r2").monthlyCost).toBeNull();
    expect(room("r2").costPerRotaHour).toBeNull();
    expect(room("r3").monthlyCost).toBeNull();
    expect(room("r3").costPerRotaHour).toBeNull();
  });

  it("a room whose rota has no doctor with known revenue has no revenue (not 0)", () => {
    expect(room("r3").revenue).toBeNull();
    expect(room("r3").revenuePerRoomHour).toBeNull();
  });

  it("shows no revenue at all when it cannot be scoped to the branch", () => {
    const x = buildCapacityReport({ ...base, revenueAvailable: false });
    expect(x.doctors.every((d) => d.revenue === null)).toBe(true);
    expect(x.rooms.every((d) => d.revenue === null)).toBe(true);
    expect(x.totals.revenue).toBeNull();
    expect(x.doctors.find((d) => d.specialistId === "d1")!.availableHours).toBe(100);
  });

  it("no open days: no occupancy rather than a division by zero", () => {
    const x = buildCapacityReport({ ...base, openDays: 0 });
    expect(x.rooms[0].occupancy).toBeNull();
  });
});

describe("revenueByDoctor", () => {
  it("sums several departments and several keys per doctor, and lists unlinked keys", () => {
    const out = revenueByDoctor(
      [
        { doctorKey: "alpha", doctorName: "ALPHA DEMO", revenue: 100.1 },
        { doctorKey: "alpha", doctorName: "ALPHA DEMO", revenue: 200.2 },
        { doctorKey: "dr alpha", doctorName: "DR ALPHA", revenue: 0.3 },
        { doctorKey: "beta", doctorName: "BETA DEMO", revenue: 50 },
        { doctorKey: "beta", doctorName: "BETA DEMO", revenue: 25 },
      ],
      new Map([
        ["alpha", "d1"],
        ["dr alpha", "d1"],
      ]),
    );
    expect(out.bySpecialist.get("d1")).toBe(300.6);
    expect(out.unlinked).toEqual([{ doctorKey: "beta", doctorName: "BETA DEMO", revenue: 75 }]);
  });
});
