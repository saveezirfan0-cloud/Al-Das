/**
 * The daily flash report (pure): the clinic's Daily Financial Summary, Month-to-date summary and Daily sales grid,
 * computed from one set of rules so the sheets can never disagree with each other.
 *
 * Inputs are aggregates from SQL `fin_flash_inputs` (per day, branch, department and doctor: net revenue, patient
 * visits, invoices; counts only, no patient identifier), the configured reporting lines and the targets.
 *
 * Rules (OQ-93; change them here and nowhere else):
 *  - Every row belongs to exactly one reporting line. Department rules win over branch rules (Chiro is a department
 *    seen in several branches); a row that matches nothing goes to UNASSIGNED, which counts in the core totals and is
 *    reported as a warning, so totals always tie back to the invoices.
 *  - "Core" lines make up "Total (excl. Chiro)"; the other lines (Chiro, the leased Dental unit) are shown separately
 *    and only added in the grand total.
 *  - Targets are daily rates per line and month. Month-to-date target = daily target x calendar days elapsed. The total
 *    revenue target is the explicit total row when one is set, otherwise the sum of the core lines' targets. Patient
 *    and ARPP targets exist for the total only, unless set per line.
 *  - ARPP = revenue / patient visits. Variance % = (actual - target) / target.
 *  - Doctor share of total: "section" divides by the doctor's own table total; "all" divides by the grand total.
 */

import { dayNumber } from "@/lib/documents/expiry";

export const UNASSIGNED = "UNASSIGNED";

export type FlashRow = {
  date: string; // YYYY-MM-DD (invoice transaction date)
  branch: string | null;
  department: string | null;
  doctorId: string | null;
  doctorName: string | null;
  net: number;
  patients: number;
  invoices: number;
};

export type ReportLine = {
  code: string;
  label: string;
  matchKind: "branch" | "department";
  matchValues: readonly string[];
  inCore: boolean;
  sortOrder: number;
};

export type RevenueTarget = {
  month: string; // YYYY-MM-01
  lineCode: string | null; // null = the total
  dailyRevenue: number | null;
  dailyPatients: number | null;
  arpp: number | null;
};

export type ShareBasis = "section" | "all";

export type Measure = {
  actual: number;
  target: number | null;
  variance: number | null;
  variancePct: number | null;
};

export type LineResult = {
  code: string;
  label: string;
  inCore: boolean;
  revenue: Measure;
  patients: number;
  patientTarget: number | null;
  arpp: number | null;
};

export type DoctorResult = {
  rank: number;
  doctorId: string | null;
  name: string;
  revenue: number;
  patients: number;
  arpp: number | null;
  share: number | null;
};

export type DoctorSection = {
  code: string; // "CORE" or a non-core line code
  label: string;
  doctors: DoctorResult[];
  total: { revenue: number; patients: number; arpp: number | null; share: number | null };
};

export type FlashSummary = {
  from: string;
  to: string;
  days: number;
  kpis: { revenue: Measure; patients: Measure; arpp: Measure };
  lines: LineResult[]; // core lines first (sort order), then UNASSIGNED if any
  coreTotal: LineResult;
  otherLines: LineResult[]; // non-core lines (Chiro, leased unit)
  grandTotal: { revenue: number; patients: number; arpp: number | null };
  doctorSections: DoctorSection[];
  warnings: string[];
};

export type SalesGrid = {
  month: string;
  columns: { code: string; label: string }[];
  days: { date: string; values: number[]; total: number }[];
  totals: number[];
  grandTotal: number;
  shares: (number | null)[];
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

const round2 = (v: number) => Math.round(v * 100) / 100;
const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

export function measure(actual: number, target: number | null): Measure {
  const a = round2(actual);
  if (target === null || !Number.isFinite(target)) {
    return { actual: a, target: null, variance: null, variancePct: null };
  }
  const t = round2(target);
  return {
    actual: a,
    target: t,
    variance: round2(a - t),
    variancePct: t > 0 ? (a - t) / t : null,
  };
}

export const arppOf = (revenue: number, patients: number): number | null =>
  patients > 0 ? round2(revenue / patients) : null;

/** First day of the month of an ISO date, or null. */
export function monthOf(date: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && dayNumber(date) !== null
    ? `${date.slice(0, 7)}-01`
    : null;
}

/** Calendar days from `from` to `to`, both included; 0 when the range is empty or invalid. */
export function daysInclusive(from: string, to: string): number {
  const f = dayNumber(from);
  const t = dayNumber(to);
  return f === null || t === null || t < f ? 0 : t - f + 1;
}

/** Every ISO date from `from` to `to`, both included. */
export function eachDay(from: string, to: string): string[] {
  const f = dayNumber(from);
  const n = daysInclusive(from, to);
  if (f === null) return [];
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(new Date((f + i) * 86_400_000).toISOString().slice(0, 10));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Lines

/**
 * The lines to report on. With nothing configured, one core line per branch seen in the data (so the page works on day
 * one); configured lines are used as they are, sorted, inactive ones already filtered out by the caller.
 */
export function effectiveLines(
  configured: readonly ReportLine[],
  rows: readonly FlashRow[],
): ReportLine[] {
  if (configured.length > 0) {
    return [...configured].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  }
  const branches = [...new Set(rows.map((r) => r.branch).filter((b): b is string => !!b))].sort();
  return branches.map((b, i) => ({
    code: b,
    label: b,
    matchKind: "branch" as const,
    matchValues: [b],
    inCore: true,
    sortOrder: i,
  }));
}

/** Which line a row belongs to: department rules first, then branch rules, else UNASSIGNED. */
export function assignLine(row: FlashRow, lines: readonly ReportLine[]): string {
  const dept = norm(row.department);
  if (dept) {
    const d = lines.find(
      (l) => l.matchKind === "department" && l.matchValues.some((v) => norm(v) === dept),
    );
    if (d) return d.code;
  }
  const br = norm(row.branch);
  if (br) {
    const b = lines.find(
      (l) => l.matchKind === "branch" && l.matchValues.some((v) => norm(v) === br),
    );
    if (b) return b.code;
  }
  return UNASSIGNED;
}

// ---------------------------------------------------------------------------------------------------------------
// Targets

type TargetSet = {
  line: Map<string, RevenueTarget>;
  total: RevenueTarget | null;
};

function targetsFor(targets: readonly RevenueTarget[], month: string): TargetSet {
  const line = new Map<string, RevenueTarget>();
  let total: RevenueTarget | null = null;
  for (const t of targets) {
    if (t.month !== month) continue;
    if (t.lineCode === null) total = t;
    else line.set(t.lineCode, t);
  }
  return { line, total };
}

const times = (rate: number | null | undefined, days: number) =>
  rate === null || rate === undefined || !Number.isFinite(rate) ? null : rate * days;

// ---------------------------------------------------------------------------------------------------------------
// The summary (one day, or month to date)

/**
 * The summary for the period `from`..`to` inside ONE month (the daily summary is from = to; month to date is from = the
 * first of the month). Targets of that month are scaled by the number of calendar days in the period.
 */
export function buildFlashSummary(input: {
  rows: readonly FlashRow[];
  lines: readonly ReportLine[];
  targets: readonly RevenueTarget[];
  from: string;
  to: string;
  shareBasis?: ShareBasis;
  topDoctors?: number | null;
}): FlashSummary {
  const { from, to } = input;
  const month = monthOf(from);
  if (!month || monthOf(to) !== month || daysInclusive(from, to) === 0) {
    throw new Error("A flash period must be one or more days inside one month.");
  }
  const days = daysInclusive(from, to);
  const shareBasis = input.shareBasis ?? "section";
  const rows = input.rows.filter((r) => r.date >= from && r.date <= to);
  const lines = effectiveLines(input.lines, input.rows);
  const t = targetsFor(input.targets, month);
  const warnings: string[] = [];

  // Per line
  const acc = new Map<string, { revenue: number; patients: number }>();
  const lineOf = new Map<FlashRow, string>();
  for (const r of rows) {
    const code = assignLine(r, lines);
    lineOf.set(r, code);
    const a = acc.get(code) ?? { revenue: 0, patients: 0 };
    a.revenue += r.net;
    a.patients += r.patients;
    acc.set(code, a);
  }
  const lineResult = (code: string, label: string, inCore: boolean): LineResult => {
    const a = acc.get(code) ?? { revenue: 0, patients: 0 };
    const lt = t.line.get(code);
    return {
      code,
      label,
      inCore,
      revenue: measure(a.revenue, times(lt?.dailyRevenue, days)),
      patients: a.patients,
      patientTarget: times(lt?.dailyPatients, days),
      arpp: arppOf(a.revenue, a.patients),
    };
  };
  const core = lines.filter((l) => l.inCore).map((l) => lineResult(l.code, l.label, true));
  if (acc.has(UNASSIGNED)) {
    core.push(lineResult(UNASSIGNED, "Unassigned", true));
    warnings.push(
      `${acc.get(UNASSIGNED)!.revenue.toFixed(2)} of revenue matches no reporting line (branch or department not configured).`,
    );
  }
  const otherLines = lines.filter((l) => !l.inCore).map((l) => lineResult(l.code, l.label, false));

  // Core total and KPIs
  const coreRevenue = core.reduce((s, l) => s + l.revenue.actual, 0);
  const corePatients = core.reduce((s, l) => s + l.patients, 0);
  const lineTargetSum = lines
    .filter((l) => l.inCore)
    .map((l) => t.line.get(l.code)?.dailyRevenue)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const totalRevenueRate =
    t.total?.dailyRevenue ?? (lineTargetSum.length > 0 ? lineTargetSum.reduce((s, v) => s + v, 0) : null);
  const totalPatientRate = t.total?.dailyPatients ?? null;
  const coreTotal: LineResult = {
    code: "CORE",
    label: "Total",
    inCore: true,
    revenue: measure(coreRevenue, times(totalRevenueRate, days)),
    patients: corePatients,
    patientTarget: times(totalPatientRate, days),
    arpp: arppOf(coreRevenue, corePatients),
  };
  const coreArpp = arppOf(coreRevenue, corePatients);
  const kpis = {
    revenue: coreTotal.revenue,
    patients: measure(corePatients, times(totalPatientRate, days)),
    arpp:
      coreArpp === null
        ? { actual: 0, target: t.total?.arpp ?? null, variance: null, variancePct: null }
        : measure(coreArpp, t.total?.arpp ?? null),
  };

  const otherRevenue = otherLines.reduce((s, l) => s + l.revenue.actual, 0);
  const otherPatients = otherLines.reduce((s, l) => s + l.patients, 0);
  const grandTotal = {
    revenue: round2(coreRevenue + otherRevenue),
    patients: corePatients + otherPatients,
    arpp: arppOf(coreRevenue + otherRevenue, corePatients + otherPatients),
  };

  // Doctors: one table for the core lines, one per non-core line
  const coreCodes = new Set(core.map((l) => l.code));
  const sections: { code: string; label: string; match: (code: string) => boolean }[] = [
    { code: "CORE", label: "All branches", match: (c) => coreCodes.has(c) },
    ...otherLines.map((l) => ({ code: l.code, label: l.label, match: (c: string) => c === l.code })),
  ];
  const doctorSections: DoctorSection[] = sections.map((s) => {
    const byDoc = new Map<string, { id: string | null; name: string; revenue: number; patients: number }>();
    for (const r of rows) {
      if (!s.match(lineOf.get(r)!)) continue;
      const key = r.doctorId ?? `name:${norm(r.doctorName)}`;
      const d = byDoc.get(key) ?? {
        id: r.doctorId,
        name: r.doctorName?.trim() || r.doctorId || "No doctor on invoice",
        revenue: 0,
        patients: 0,
      };
      d.revenue += r.net;
      d.patients += r.patients;
      if (r.doctorName?.trim()) d.name = r.doctorName.trim();
      byDoc.set(key, d);
    }
    const sectionRevenue = [...byDoc.values()].reduce((a, d) => a + d.revenue, 0);
    const sectionPatients = [...byDoc.values()].reduce((a, d) => a + d.patients, 0);
    const denominator = shareBasis === "all" ? grandTotal.revenue : sectionRevenue;
    const sorted = [...byDoc.values()].sort(
      (a, b) => b.revenue - a.revenue || b.patients - a.patients || a.name.localeCompare(b.name),
    );
    const limited =
      input.topDoctors && input.topDoctors > 0 ? sorted.slice(0, input.topDoctors) : sorted;
    return {
      code: s.code,
      label: s.label,
      doctors: limited.map((d, i) => ({
        rank: i + 1,
        doctorId: d.id,
        name: d.name,
        revenue: round2(d.revenue),
        patients: d.patients,
        arpp: arppOf(d.revenue, d.patients),
        share: denominator > 0 ? d.revenue / denominator : null,
      })),
      total: {
        revenue: round2(sectionRevenue),
        patients: sectionPatients,
        arpp: arppOf(sectionRevenue, sectionPatients),
        share: denominator > 0 ? sectionRevenue / denominator : null,
      },
    };
  });

  if (rows.length === 0) warnings.push("No invoices in this period yet.");
  const noDoctor = rows.filter((r) => !r.doctorId && !r.doctorName?.trim());
  if (noDoctor.length > 0) {
    warnings.push(
      `${noDoctor.reduce((s, r) => s + r.net, 0).toFixed(2)} of revenue has no doctor on the invoice.`,
    );
  }
  if (totalRevenueRate === null) warnings.push("No revenue target is set for this month.");

  return {
    from,
    to,
    days,
    kpis,
    lines: core,
    coreTotal,
    otherLines,
    grandTotal,
    doctorSections,
    warnings,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The daily sales grid (one row per calendar day of the month up to `asOf`, one column per line)

export function buildSalesGrid(input: {
  rows: readonly FlashRow[];
  lines: readonly ReportLine[];
  month: string; // YYYY-MM-01
  asOf: string; // last day shown
}): SalesGrid {
  const month = monthOf(input.month);
  if (!month || month !== input.month || monthOf(input.asOf) !== month) {
    throw new Error("The sales grid needs a month and a day inside it.");
  }
  const lines = effectiveLines(input.lines, input.rows);
  const columns = [
    ...lines.filter((l) => l.inCore),
    ...lines.filter((l) => !l.inCore),
  ].map((l) => ({ code: l.code, label: l.label }));
  const rows = input.rows.filter((r) => r.date >= month && r.date <= input.asOf);
  if (rows.some((r) => assignLine(r, lines) === UNASSIGNED)) {
    columns.push({ code: UNASSIGNED, label: "Unassigned" });
  }
  const index = new Map(columns.map((c, i) => [c.code, i]));
  const cells = new Map<string, number[]>();
  for (const d of eachDay(month, input.asOf)) cells.set(d, columns.map(() => 0));
  for (const r of rows) {
    const v = cells.get(r.date);
    if (!v) continue;
    v[index.get(assignLine(r, lines))!] += r.net;
  }
  const days = [...cells.entries()].map(([date, values]) => {
    const rounded = values.map(round2);
    return { date, values: rounded, total: round2(rounded.reduce((a, b) => a + b, 0)) };
  });
  const totals = columns.map((_, i) => round2(days.reduce((a, d) => a + d.values[i], 0)));
  const grandTotal = round2(totals.reduce((a, b) => a + b, 0));
  return {
    month,
    columns,
    days,
    totals,
    grandTotal,
    shares: totals.map((t) => (grandTotal > 0 ? t / grandTotal : null)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Parsing what SQL and the settings tables return

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const optNum = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const optStr = (v: unknown): string | null =>
  v === null || v === undefined || String(v).trim() === "" ? null : String(v);

export function parseFlashRows(json: unknown): FlashRow[] {
  const list = (json as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return {
        date: String(o.date ?? ""),
        branch: optStr(o.branch),
        department: optStr(o.department),
        doctorId: optStr(o.doctor_id),
        doctorName: optStr(o.doctor_name),
        net: num(o.net),
        patients: Math.max(0, Math.trunc(num(o.patients))),
        invoices: Math.max(0, Math.trunc(num(o.invoices))),
      };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date));
}

export function lineFromRow(r: {
  code: string;
  label: string;
  match_kind: string;
  match_values: string[] | null;
  in_core: boolean;
  sort_order: number;
}): ReportLine {
  return {
    code: r.code,
    label: r.label,
    matchKind: r.match_kind === "department" ? "department" : "branch",
    matchValues: (r.match_values ?? []).filter((v) => v.trim() !== ""),
    inCore: r.in_core,
    sortOrder: r.sort_order,
  };
}

export function targetFromRow(r: {
  month: string;
  line_code: string | null;
  daily_revenue: number | string | null;
  daily_patients: number | string | null;
  arpp: number | string | null;
}): RevenueTarget {
  return {
    month: r.month,
    lineCode: r.line_code,
    dailyRevenue: optNum(r.daily_revenue),
    dailyPatients: optNum(r.daily_patients),
    arpp: optNum(r.arpp),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Display helpers (shared by the page and the workbook)

/** "-13%" / "87%": whole percent, as on the clinic's sheets. */
export function pctLabel(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  return `${Math.round(v * 100)}%`;
}

/** Positive is good for every flash measure. */
export function tone(v: number | null): "good" | "bad" | "neutral" {
  if (v === null || !Number.isFinite(v) || Math.abs(v) < 1e-9) return "neutral";
  return v > 0 ? "good" : "bad";
}

/** Target editor input: a decimal with at most 2 places, or blank (null). Throws on anything else. */
export function parseTargetInput(raw: string | undefined | null, max = 100_000_000): number | null {
  const s = (raw ?? "").replace(/,/g, "").trim();
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`"${raw}" is not an amount.`);
  const v = Number(s);
  if (!(v > 0) || v > max) throw new Error(`"${raw}" is out of range.`);
  return v;
}

export const LINE_CODE_RE = /^[A-Z0-9_]{1,12}$/;

// ---------------------------------------------------------------------------------------------------------------
// Comparison with the same days of the previous month (the clinic puts the two daily sales grids side by side)

/**
 * The same stretch of the previous month: from its first day to the same day of the month as `asOf`, clamped to the
 * previous month's length (31 March compares with 1 to 28/29 February).
 */
export function previousMonthPeriod(asOf: string): { month: string; asOf: string } | null {
  const month = monthOf(asOf);
  if (!month) return null;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  const day = Math.min(Number(asOf.slice(8, 10)), lastDay);
  const p = `${py}-${String(pm).padStart(2, "0")}`;
  return { month: `${p}-01`, asOf: `${p}-${String(day).padStart(2, "0")}` };
}

export type GridComparison = {
  rows: { code: string; label: string; current: number; previous: number; change: number; changePct: number | null }[];
  total: { current: number; previous: number; change: number; changePct: number | null };
};

/** Column by column (matched on line code) and in total: this month to date against the same days last month. */
export function compareGrids(current: SalesGrid, previous: SalesGrid): GridComparison {
  const prev = new Map(previous.columns.map((c, i) => [c.code, previous.totals[i]]));
  const pct = (c: number, p: number) => (p > 0 ? (c - p) / p : null);
  const codes = [
    ...current.columns.map((c, i) => ({ code: c.code, label: c.label, current: current.totals[i] })),
    ...previous.columns
      .filter((c) => !current.columns.some((x) => x.code === c.code))
      .map((c) => ({ code: c.code, label: c.label, current: 0 })),
  ];
  return {
    rows: codes.map((c) => {
      const p = prev.get(c.code) ?? 0;
      return { ...c, previous: p, change: round2(c.current - p), changePct: pct(c.current, p) };
    }),
    total: {
      current: current.grandTotal,
      previous: previous.grandTotal,
      change: round2(current.grandTotal - previous.grandTotal),
      changePct: pct(current.grandTotal, previous.grandTotal),
    },
  };
}
