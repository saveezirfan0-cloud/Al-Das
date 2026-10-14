import { describe, expect, it } from "vitest";

import { buildCapacityReport, revenueByDoctor, type CapacityInputs } from "@/lib/capacity/measures";

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
    { id: "r3", name: "Room 3", locationName: "Acacia", kind: "dental", monthlyCost: 0 },
  ],
};

describe("buildCapacityReport", () => {
  const r = buildCapacityReport(base);
  const room = (id: string) => r.rooms.find((x) => x.id === id)!;
  const doctor = (id: string) => r.doctors.find((x) => x.specialistId === id)!;

  it("revenue per available hour; unknown when there are no hours or no link", () => {
    expect(doctor("d1").availableHours).toBe(100);
    expect(doctor("d1").revenuePerAvailableHour).toBe(100);
    expect(doctor("d2").revenuePerAvailableHour).toBe(60);
    expect(doctor("d3").revenuePerAvailableHour).toBeNull();
    expect(doctor("d4").revenue).toBeNull();
    expect(doctor("d4").revenuePerAvailableHour).toBeNull();
  });

  it("totals: linked revenue to the thousandth, and revenue per hour over doctors with both sides known", () => {
    expect(r.totals.availableHours).toBe(190);
    expect(r.totals.revenue).toBe(13_999.501);
    // d1 and d2 only: 13,000.001 over 150 h (d3 has no hours, d4 no link)
    expect(r.totals.revenuePerAvailableHour).toBe(86.67);
  });

  it("rooms carry open hours (open days x the setting), sorted by branch then name", () => {
    expect(r.rooms.map((x) => x.id)).toEqual(["r3", "r1", "r2"]);
    expect(room("r1").openHours).toBe(200);
  });

  it("an unknown cost stays unknown and a 0 cost is never used as a number", () => {
    expect(room("r1").monthlyCost).toBe(6000);
    expect(room("r2").monthlyCost).toBeNull();
    expect(room("r3").monthlyCost).toBeNull();
  });

  it("shows no revenue at all when it cannot be scoped to the branch", () => {
    const x = buildCapacityReport({ ...base, revenueAvailable: false });
    expect(x.doctors.every((d) => d.revenue === null && d.revenuePerAvailableHour === null)).toBe(
      true,
    );
    expect(x.totals.revenue).toBeNull();
    expect(x.totals.revenuePerAvailableHour).toBeNull();
    expect(x.doctors.find((d) => d.specialistId === "d1")!.availableHours).toBe(100);
  });

  it("no linked doctor: revenue unknown, not 0", () => {
    const x = buildCapacityReport({
      ...base,
      doctors: base.doctors.map((d) => ({ ...d, revenue: null })),
    });
    expect(x.totals.revenue).toBeNull();
    expect(x.totals.revenuePerAvailableHour).toBeNull();
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
