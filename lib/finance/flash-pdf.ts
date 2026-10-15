import { MARGIN, makeDoc, PAGE_W } from "@/lib/accounting/sales-pdf";
import type { FlashSummary, LineResult, Measure } from "@/lib/finance/flash";
import { monthTitle, sheetDate } from "@/lib/finance/flash-xlsx";

/**
 * The daily flash as a PDF (Phase G): the day and month to date, each with the KPIs against target and the revenue by
 * reporting line, then the top doctors (names as the flash page shows them). Built from the same summaries as the page
 * and the workbook (lib/finance/flash.ts), so the figures cannot differ. Aggregates only; no patient data.
 */

export type FlashPdfInput = {
  org: string;
  day: string;
  month: string;
  daily: FlashSummary;
  monthToDate: FlashSummary;
  topDoctors: number;
  status: string;
  builtAt: string;
};

const whole = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : Math.round(n).toLocaleString("en-GB");
const pct = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "-" : `${Math.round(n * 100)}%`;

export async function flashPdf(i: FlashPdfInput): Promise<Buffer> {
  const p = await makeDoc(`Daily flash ${i.day}`, new Date(i.builtAt));
  p.text(i.org || "Pulse", MARGIN, 12, p.bold);
  p.right("Daily flash report", PAGE_W - MARGIN, 14, p.bold);
  p.y -= 18;
  p.para(`Day ${sheetDate(i.day)}; month to date ${monthTitle(i.month)}.`, 9);
  p.para(i.status, 9, p.bold);
  p.para("Amounts in AED, rounded to the dirham.", 8, p.font, p.grey);

  const kpis = (s: FlashSummary) => {
    const row = (label: string, m: Measure) => [
      label,
      whole(m.actual),
      whole(m.target),
      whole(m.variance),
      pct(m.variancePct),
    ];
    p.table(
      [
        { label: "Measure", width: 155 },
        { label: "Actual", width: 90, align: "right" },
        { label: "Target", width: 90, align: "right" },
        { label: "Variance", width: 90, align: "right" },
        { label: "Variance %", width: 90.28, align: "right" },
      ],
      [
        row("Net revenue", s.kpis.revenue),
        row("Patient volume", s.kpis.patients),
        row("Revenue per patient", s.kpis.arpp),
      ],
    );
    p.y -= 4;
    const line = (l: LineResult, label = l.label) => [
      label,
      whole(l.revenue.actual),
      whole(l.revenue.target),
      pct(l.revenue.variancePct),
      whole(l.patients),
      whole(l.arpp),
    ];
    p.table(
      [
        { label: "Line", width: 165 },
        { label: "Revenue", width: 75, align: "right" },
        { label: "Target", width: 75, align: "right" },
        { label: "Variance %", width: 65, align: "right" },
        { label: "Patients", width: 60, align: "right" },
        { label: "Per patient", width: 75.28, align: "right" },
      ],
      [
        ...s.lines.map((l) => line(l)),
        line(s.coreTotal, "Total (core lines)"),
        ...s.otherLines.map((l) => line(l)),
        [
          "Total (all lines)",
          whole(s.grandTotal.revenue),
          "",
          "",
          whole(s.grandTotal.patients),
          whole(s.grandTotal.arpp),
        ],
      ],
      true,
    );
    const core = s.doctorSections.find((d) => d.code === "CORE");
    if (core && core.doctors.length > 0 && i.topDoctors > 0) {
      p.y -= 4;
      p.table(
        [
          { label: `Top ${i.topDoctors} doctors`, width: 215 },
          { label: "Revenue", width: 100, align: "right" },
          { label: "Patients", width: 100, align: "right" },
          { label: "Share", width: 100.28, align: "right" },
        ],
        core.doctors
          .slice(0, i.topDoctors)
          .map((d) => [`${d.rank}. ${d.name}`, whole(d.revenue), whole(d.patients), pct(d.share)]),
      );
    }
    for (const w of s.warnings) p.para(`Note: ${w}`, 8, p.font, p.grey);
  };

  p.heading(`The day, ${sheetDate(i.day)}`);
  kpis(i.daily);
  p.heading(`Month to date, ${monthTitle(i.month)}`);
  kpis(i.monthToDate);
  p.y -= 6;
  p.para(`Built ${i.builtAt.slice(0, 16).replace("T", " ")} UTC.`, 8, p.font, p.grey);
  p.footer(`Daily flash ${i.day} - ${i.status.startsWith("Final") ? "Final" : "Provisional"}`);
  return Buffer.from(await p.doc.save());
}
