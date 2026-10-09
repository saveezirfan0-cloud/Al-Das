import { describe, expect, it } from "vitest";

import { appointmentsReport, uniteAppointmentsReport } from "@/lib/reports/queries";
import { DEFAULT_FILTERS } from "@/lib/reports/filters";
import type { ReportContext } from "@/lib/reports/types";

function ctx(data: Record<string, unknown[]>): ReportContext {
  const admin = { rpc: async (fn: string) => ({ data: data[fn] ?? [], error: null }) };
  return {
    admin: admin as never,
    orgId: "org",
    timezone: "Asia/Dubai",
    filters: DEFAULT_FILTERS,
    range: { fromDay: "2026-03-01", toDay: "2026-03-31" } as never,
  };
}

describe("appointment reports", () => {
  it("computes no-show rate as no-shows / (completed + no-shows), not over cancelled or open appointments", async () => {
    const r = await appointmentsReport(
      ctx({
        report_appointments_summary: [{ total: 20, awaiting: 4, confirmed: 3, cancelled: 3, completed: 9, no_show: 1 }],
        report_appointments_by_specialist: [
          { specialist_id: "s", specialist_name: "Dr Test", total: 10, completed: 0, cancelled: 2, no_show: 0 },
        ],
      }),
    );
    const k = Object.fromEntries(r.kpis.map((x) => [x.key, x.value]));
    expect(k.rate).toBeCloseTo(0.1);
    expect(k.open).toBe(7);
    // no outcomes yet -> no rate, not 0%
    expect(r.table.rows[0].no_show_rate).toBeNull();
  });

  it("returns an empty report cleanly", async () => {
    const r = await appointmentsReport(ctx({}));
    expect(r.kpis.find((x) => x.key === "total")?.value).toBe(0);
    expect(r.kpis.find((x) => x.key === "rate")?.value).toBeNull();
    expect(r.table.rows).toEqual([]);
  });

  it("flags Unite status codes that are not mapped yet", async () => {
    const r = await uniteAppointmentsReport(
      ctx({
        report_unite_appointments_by_day: [
          { day: "2026-03-11", appointments: 3, unmapped: 1 },
          { day: "2026-03-12", appointments: 1, unmapped: 1 },
        ],
        report_unite_status_codes: [
          { code: "NSW", mapped_status: "no_show", appointments: 2 },
          { code: "AAC", mapped_status: null, appointments: 2 },
        ],
      }),
    );
    expect(r.kpis.find((x) => x.key === "unmapped")?.value).toBe(2);
    const bars = r.charts.find((c) => c.kind === "hbars" && c.title.includes("status"));
    expect(bars && bars.kind === "hbars" && bars.items.map((i) => i.label)).toEqual(["NSW (no_show)", "AAC (not mapped)"]);
  });
});
