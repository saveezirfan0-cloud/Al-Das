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

describe("enquiry and campaign reports", () => {
  it("computes conversion over closed enquiries only, and shows no rate when none closed", async () => {
    const { enquiryFunnelReport } = await import("@/lib/reports/queries");
    const r = await enquiryFunnelReport(
      ctx({
        report_enquiries_summary: [{ created: 10, open_now: 4, won: 3, lost: 1, disqualified: 0, won_value: 900 }],
        report_enquiry_funnel: [{ pipeline_id: "p", pipeline_name: "Main", stage_id: "s", stage_name: "New", entered: 10, open_now: 4, won_here: 0, lost_here: 0, disqualified_here: 0 }],
      }),
    );
    const k = Object.fromEntries(r.kpis.map((x) => [x.key, x.value]));
    expect(k.conversion).toBeCloseTo(0.75);
    expect(k.open).toBe(4);
    const empty = await enquiryFunnelReport(ctx({}));
    expect(empty.kpis.find((x) => x.key === "conversion")?.value).toBeNull();
  });

  it("weights the average time in stage by the number of stays", async () => {
    const { enquiryStageTimeReport } = await import("@/lib/reports/queries");
    const r = await enquiryStageTimeReport(
      ctx({
        report_enquiry_stage_times: [
          { pipeline_id: "p", pipeline_name: "Main", stage_id: "a", stage_name: "New", stays: 3, avg_seconds: "100", median_seconds: 90 },
          { pipeline_id: "p", pipeline_name: "Main", stage_id: "b", stage_name: "Booked", stays: 1, avg_seconds: "500", median_seconds: 500 },
        ],
      }),
    );
    const k = Object.fromEntries(r.kpis.map((x) => [x.key, x.value]));
    expect(k.avg).toBe(200); // (3*100 + 1*500) / 4
    expect(k.slowest).toBe(500);
  });

  it("rates campaigns against the right denominators", async () => {
    const { campaignsReport } = await import("@/lib/reports/queries");
    const r = await campaignsReport(
      ctx({
        report_campaigns: [
          { campaign_id: "c", name: "Spring", status: "completed", channel_name: "A", started_at: null, total: 10, eligible: 8, sent: 8, delivered: 4, read_count: 2, replied: 1, failed: 0, skipped: 2 },
        ],
      }),
    );
    const k = Object.fromEntries(r.kpis.map((x) => [x.key, x.value]));
    expect(k.delivered).toBeCloseTo(0.5); // of sent
    expect(k.read).toBeCloseTo(0.5); // of delivered
    expect(k.replied).toBeCloseTo(0.25); // of delivered
  });
});
