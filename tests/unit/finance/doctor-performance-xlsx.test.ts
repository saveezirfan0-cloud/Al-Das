import { describe, expect, it } from "vitest";

import { buildDoctorPerformance, parseDoctorPerformanceInputs } from "@/lib/finance/doctor-performance";
import { doctorPerformanceWorkbook } from "@/lib/finance/doctor-performance-xlsx";

import fixture from "./fixtures/phase23-doctor-performance.synthetic.json";

describe("doctor performance workbook", () => {
  it("has Doctors, Departments and Definitions with Pulse's values and no formulas", async () => {
    const report = buildDoctorPerformance(parseDoctorPerformanceInputs(fixture.expected));
    const buf = await doctorPerformanceWorkbook({
      org: "Synthetic Clinic",
      report,
      branchLabel: "All branches",
      builtAt: "2026-10-14T06:00:00.000Z",
    });
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Doctors", "Departments", "Definitions"]);

    const cells = (name: string) => {
      const out: unknown[] = [];
      wb.getWorksheet(name)!.eachRow((r) => r.eachCell((c) => out.push(c.value)));
      return out;
    };
    let formulas = 0;
    for (const ws of wb.worksheets)
      ws.eachRow((r) =>
        r.eachCell((c) => {
          if (c.formula || (typeof c.value === "object" && c.value !== null && "formula" in c.value)) formulas++;
        }),
      );
    expect(formulas).toBe(0);

    const doctors = cells("Doctors");
    expect(doctors).toContain("Dr Demo-01");
    expect(doctors).toContain("Dr Demo-05"); // last month only
    expect(doctors).toContain(1349.995);
    expect(doctors).toContain("Below Target");
    // a doctor in two departments has two rows
    const rows: unknown[][] = [];
    wb.getWorksheet("Doctors")!.eachRow((r) => rows.push(r.values as unknown[]));
    expect(rows.filter((r) => r[2] === "Dr Demo-01").map((r) => r[1])).toEqual([
      "General Medicine",
      "Dermatology",
    ]);

    const depts = cells("Departments");
    expect(depts).toContain("Total (clinic)");
    expect(depts).toContain(6499.985);
    expect(depts).toContain("Unassigned");
    expect(depts.some((v) => typeof v === "string" && v.includes("(matches)"))).toBe(true);
    expect(depts.some((v) => typeof v === "string" && v.includes("1 cancelled"))).toBe(true);

    const defs = cells("Definitions");
    expect(defs).toContain("Change %");
    expect(defs).toEqual(expect.arrayContaining([750, 700, 650]));

    // no PIN or patient ref anywhere
    expect(JSON.stringify(wb.worksheets.map((w) => cells(w.name)))).not.toMatch(/9000000\d\d|P-syn/);
  });
});
