import {
  CALENDAR_KIND_LABEL,
  CONTRACT_LABEL,
  INDIRECT_ITEMS,
  RECRUIT_BAND_LABEL,
  VIABILITY_LABEL,
  type RecruitmentInputs,
  type ScenarioReport,
} from "@/lib/finance/recruitment";

/**
 * A saved recruitment scenario as an .xlsx workbook: one "Scenario" sheet with a banner, the inputs, the result, the
 * benchmark and the seasonal note. Every cell is a plain value (no formulas), taken from the stored scenario, so the
 * file says exactly what was saved. It is a scenario: never actual figures and never pay.
 */

export type RecruitmentWorkbookInput = {
  org: string;
  title: string;
  createdAt: string;
  inputs: RecruitmentInputs;
  report: ScenarioReport;
  builtAt: string;
};

export const SCENARIO_BANNER =
  "SCENARIO: a projection from a candidate's claimed revenue and assumed costs. Not actual figures, not a contract and not pay.";

const MONEY = "#,##0.00;[Red](#,##0.00)";
const PCT = "0.0%;[Red]-0.0%";

export async function recruitmentWorkbook(input: RecruitmentWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const when = new Date(input.builtAt);
  wb.creator = "Pulse";
  wb.created = when;
  wb.modified = when;
  const ws = wb.addWorksheet("Scenario");
  ws.columns = [{ width: 46 }, { width: 22 }, { width: 60 }];

  const i = input.inputs;
  const r = input.report.result;
  const b = input.report.benchmark;

  const banner = ws.addRow([SCENARIO_BANNER]);
  banner.font = { bold: true, color: { argb: "FF7A4B00" } };
  banner.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF1D6" } };
  ws.mergeCells(banner.number, 1, banner.number, 3);
  ws.addRow([`Scenario: ${input.title}`]).font = { bold: true, size: 13 };
  ws.addRow([
    `${input.org}. Saved ${input.createdAt.slice(0, 10)}; file built ${input.builtAt.slice(0, 10)}.`,
  ]);
  ws.addRow([]);

  const section = (text: string) => {
    const row = ws.addRow([text]);
    row.font = { bold: true };
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCEBF0" } };
  };
  const line = (label: string, value: string | number | null, fmt?: string, note?: string) => {
    const row = ws.addRow([label, value === null ? "" : value, note ?? ""]);
    if (fmt && typeof value === "number") row.getCell(2).numFmt = fmt;
  };
  const pct = (v: number) => v / 100;

  section("Inputs");
  line("Department", i.department ?? "Not chosen");
  line("Contract type", CONTRACT_LABEL[i.contractType]);
  if (i.contractType === "fixed_salary" || i.contractType === "salary_backed_share")
    line("Monthly salary package (AED)", i.salary, MONEY);
  if (i.contractType !== "fixed_salary") {
    line("Doctor's share", pct(i.sharePct), PCT);
    line(
      "Share basis",
      i.shareBasis === "gross" ? "Gross revenue" : "Revenue after consumables and gateway",
    );
  }
  line("Claimed monthly revenue (AED)", i.claimedRevenue, MONEY);
  line("Conservative factor on claimed revenue", pct(i.conservativePct), PCT);
  line("Revenue from the candidate's equipment (AED)", i.equipmentRevenue, MONEY);
  line("Revenue from the candidate's nurse or coordinator (AED)", i.staffRevenue, MONEY);
  line("Consumables", pct(i.consumablesPct), PCT, "of revenue");
  line("Payment gateway", pct(i.gatewayPct), PCT, "of revenue");
  line("One-off setup cost (AED)", i.setupCost, MONEY);
  line("Start month", i.startMonth ? i.startMonth.slice(0, 7) : "Not chosen");
  ws.addRow([]);

  section("Indirect monthly costs (AED, spread evenly)");
  for (const it of INDIRECT_ITEMS) {
    const v = i.indirect[it.key];
    if (!v) continue;
    const monthly = r.indirect.find((x) => x.key === it.key)?.monthly ?? 0;
    line(
      it.label,
      monthly,
      MONEY,
      `${v.amount.toFixed(2)} over ${v.months} month(s)${it.doctor ? "; cost to company" : ""}`,
    );
  }
  line("Total indirect", r.indirectMonthly, MONEY);
  ws.addRow([]);

  section("Monthly result (AED)");
  line("Revenue (claimed × factor + equipment + nurse/coordinator)", r.revenue.total, MONEY);
  line("Consumables", r.consumables, MONEY);
  line("Payment gateway", r.gateway, MONEY);
  line("Gross margin", r.grossMargin, MONEY);
  line("Gross margin %", r.grossMarginPct, PCT);
  if (r.shareAmount !== null) line("Share as calculated", r.shareAmount, MONEY);
  line("Doctor pay", r.doctorPay, MONEY, r.payBasis === "salary" ? "the salary" : "the share");
  line("Net margin", r.netMargin, MONEY);
  line("Net margin %", r.netMarginPct, PCT);
  line("Indirect costs", r.indirectMonthly, MONEY);
  line("Profit per month", r.profitMonthly, MONEY);
  line("Profit per year (× 12)", r.profitAnnual, MONEY);
  line(
    "Cost to company",
    r.costToCompany,
    MONEY,
    "doctor pay plus the doctor's own employment costs",
  );
  line("Cost to company % of revenue", r.ctcPctOfRevenue, PCT);
  line("Revenue per AED paid to the doctor", r.revenuePerAedPaid, "0.00");
  line(
    "Viability",
    VIABILITY_LABEL[r.viability],
    undefined,
    "Viable: profit > 0. Marginal: net margin > 0, profit ≤ 0.",
  );
  ws.addRow([]);

  section("Breakeven");
  line(
    "Breakeven revenue per month (AED)",
    r.breakeven.revenue ?? "Never",
    MONEY,
    r.breakeven.revenue === null
      ? "the margin after variable costs and pay cannot cover the fixed costs"
      : undefined,
  );
  line(
    "Fixed costs at breakeven",
    r.breakeven.fixedCosts,
    MONEY,
    "indirect costs, plus the salary while it is the pay",
  );
  line("Contribution margin ratio", r.breakeven.contributionRatio, PCT);
  line("Breakeven % of revenue", r.breakeven.pctOfRevenue, PCT);
  line("Safety margin", r.breakeven.safetyMargin, PCT);
  line("Months to recover the setup cost", r.monthsToRecover ?? "Never at this profit");
  ws.addRow([]);

  section("Benchmark (the clinic's own Unite report data)");
  line(
    "Compared with",
    b.source === "department"
      ? (i.department ?? "")
      : b.source === "clinic"
        ? "Clinic-wide"
        : "No benchmark",
    undefined,
    b.reason ?? undefined,
  );
  line("Median monthly net revenue per doctor", b.median, MONEY);
  line("75th percentile", b.p75, MONEY);
  line(
    "Doctor-months / doctors",
    b.doctorMonths === null ? null : `${b.doctorMonths} / ${b.doctors}`,
  );
  line("Band", b.band ? RECRUIT_BAND_LABEL[b.band] : "None");
  ws.addRow([]);

  section("Seasonal note");
  const s = input.report.season;
  if (!s) line("Start month", "Not chosen");
  else if (s.events.length === 0) line(`${s.from} to ${s.to}`, "No calendar events");
  else
    for (const e of s.events)
      line(
        `${e.label} (${CALENDAR_KIND_LABEL[e.kind]})`,
        `${e.startsOn} to ${e.endsOn}`,
        undefined,
        e.approximate ? "approximate until announced" : undefined,
      );
  ws.addRow([
    "No seasonal factor is applied: the clinic's history is too short to measure one. The events are listed for judgement only.",
  ]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}
