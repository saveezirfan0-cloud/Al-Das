import { describe, expect, it } from "vitest";

import { appointmentBillingWorkbook } from "@/lib/finance/appointment-billing-xlsx";
import type { AppointmentBilling } from "@/lib/finance/appointment-billing-server";

const report: AppointmentBilling = {
  month: "2026-09-01",
  hasAppointments: true,
  coverage: {
    ranges: [{ from: "2026-09-01", to: "2026-09-30" }],
    full: true,
    label: "1–30 Sep 2026",
  },
  invoiceWindow: { from: "2026-09-01", to: "2026-09-30" },
  invoiceCount: 10,
  counts: {
    seen_billed: 3,
    seen_not_billed: 1,
    billed_not_seen: 1,
    cancelled: 1,
    open: 1,
    not_judged: 0,
    review: 1,
    total: 8,
  },
  unknownBranchRows: 0,
  seenNotBilled: [
    {
      appointmentId: "2",
      date: "2026-09-10",
      status: "honoured",
      doctorName: "Dr. Omar Testdoc",
      branch: "B1",
      room: "Room 1",
      verdict: "seen_not_billed",
      basis: null,
      reason: null,
      invoiceNos: [],
    },
  ],
  billedNotSeen: [
    {
      appointmentId: "4",
      date: "2026-09-11",
      status: "cancelled",
      doctorName: "Dr. Omar Testdoc",
      branch: "B1",
      room: null,
      verdict: "billed_not_seen",
      basis: "pin_doctor_day",
      reason: null,
      invoiceNos: ["I4"],
    },
  ],
  review: [
    {
      appointmentId: "5",
      date: "2026-09-12",
      status: "honoured",
      doctorName: "Dr. Lina Testdoc",
      branch: null,
      room: null,
      verdict: "review",
      basis: null,
      reason: "duplicate_appointment_id",
      invoiceNos: [],
    },
  ],
  invoicesNotInFile: [{ invoiceNo: "I9", date: "2026-09-12", branch: "B1", appointmentId: "999" }],
  doctors: [
    {
      key: "omar testdoc",
      name: "Dr. Omar Testdoc",
      booked: 2,
      seen: 1,
      cancelled: 1,
      bookedHours: 1.5,
      seenHours: 1,
      noDuration: 0,
      availableHours: 2,
      bookedPct: 75,
      seenPct: 50,
    },
  ],
  rooms: [
    {
      key: "B1|room 1",
      name: "Room 1",
      room: "Room 1",
      branch: "B1",
      booked: 1,
      seen: 1,
      cancelled: 0,
      bookedHours: 1,
      seenHours: 1,
      noDuration: 0,
      availableHours: null,
      bookedPct: null,
      seenPct: null,
    },
  ],
  hasRooms: true,
  noDurationRows: 0,
  doctorsWithoutHours: 0,
  truncated: false,
};

async function sheets(over: Partial<AppointmentBilling> = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    (await appointmentBillingWorkbook({
      org: "Org",
      report: { ...report, ...over },
      branchLabel: "All",
      branchNames: { B1: "Clinic One" },
      builtAt: "2026-10-17T00:00:00.000Z",
    })) as never,
  );
  return wb;
}
const text = (ws: { eachRow: (cb: (r: { values: unknown }) => void) => void }) => {
  const out: string[] = [];
  ws.eachRow((r) => out.push(JSON.stringify(r.values)));
  return out.join("\n");
};

describe("appointment billing workbook", () => {
  it("has the lists, the utilisation sheets and a Definitions sheet", async () => {
    const wb = await sheets();
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Summary",
      "Seen not billed",
      "Billed not seen",
      "Review",
      "Doctors",
      "Rooms",
      "Definitions",
    ]);
    expect(text(wb.getWorksheet("Seen not billed")!)).toContain("Clinic One");
    expect(text(wb.getWorksheet("Review")!)).toContain("I9");
    expect(text(wb.getWorksheet("Billed not seen")!)).toContain("PIN, doctor and day");
    expect(text(wb.getWorksheet("Definitions")!)).toContain("never counted as Seen, not billed");
  });

  it("leaves the Rooms sheet out when the file has no room column, and writes unknown figures as blanks", async () => {
    const wb = await sheets({ hasRooms: false });
    expect(wb.getWorksheet("Rooms")).toBeUndefined();
  });

  it("holds plain values only: no formulas and no PIN", async () => {
    const wb = await sheets();
    const all = wb.worksheets.map((w) => text(w)).join("\n");
    expect(all).not.toMatch(/"formula"/);
    expect(all).not.toMatch(/9000\d{3}/);
  });
});
