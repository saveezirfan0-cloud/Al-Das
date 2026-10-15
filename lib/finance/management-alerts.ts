import { z } from "zod";

import { dayNumber } from "@/lib/documents/expiry";
import { bandOf, type DateRange, type DoctorPerformance } from "@/lib/finance/doctor-performance";
import {
  buildFlashSummary,
  eachDay,
  effectiveLines,
  monthOf,
  parseFlashRows,
  type FlashRow,
  type ReportLine,
  type RevenueTarget,
} from "@/lib/finance/flash";
import { monthTitle } from "@/lib/finance/flash-xlsx";

/**
 * M1 management alerts (docs/23_PHASE_23E_NOTES.md). Pure: the daily finance_workflows job reads the inputs, these
 * rules decide which alerts are active, and the job claims each new one atomically in SQL (fin_mgmt_alert_claim) before
 * it notifies, so an alert is announced once per rule, scope and period until it clears.
 *
 *   report_late     no committed Unite collection report covers any of the last N days (scope 'all', period '-')
 *   revenue_behind  month-to-date net revenue below P % of the target, scaled by the days covered by committed report
 *                   data (not calendar days), on each of the last D covered days (scope 'total' or 'line:<code>',
 *                   period 'yyyy-mm'). Lines, targets and their totals follow lib/finance/flash.ts exactly.
 *   band_below      once the previous month is fully covered: doctors whose revenue per patient is Below Target
 *                   (bandOf, the 23B rule) with at least M patients (scope 'all', period 'yyyy-mm'). Never clears: one
 *                   notification per month.
 *
 * Every threshold comes from fin_ref_finance_settings. Messages carry counts and a month only: never a doctor, an
 * amount or patient data; push and e-mail use the fixed sentences in lib/notify/push-payload.ts.
 */

export type MgmtAlertRule = "report_late" | "revenue_behind" | "band_below";
export const MGMT_ALERT_RULES: readonly MgmtAlertRule[] = [
  "report_late",
  "revenue_behind",
  "band_below",
];

/** Whether an alert of this rule clears when its condition stops (band_below is announced once per month). */
export const RULE_CLEARS: Record<MgmtAlertRule, boolean> = {
  report_late: true,
  revenue_behind: true,
  band_below: false,
};

export type AlertKey = { rule: MgmtAlertRule; scope: string; period: string };
export const keyId = (k: AlertKey) => `${k.rule}|${k.scope}|${k.period}`;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type MgmtAlertSettings = {
  reportLateDays: number;
  revenueTargetPct: number;
  revenueTargetDays: number;
  bandMinPatients: number;
};

/** The table's own defaults; used only when an org has no settings row yet. */
export const DEFAULT_MGMT_ALERT_SETTINGS: MgmtAlertSettings = {
  reportLateDays: 3,
  revenueTargetPct: 90,
  revenueTargetDays: 3,
  bandMinPatients: 10,
};

type SettingsRow = {
  alert_report_late_days: number | string | null;
  alert_revenue_target_pct: number | string | null;
  alert_revenue_target_days: number | string | null;
  alert_band_min_patients: number | string | null;
};

export function mgmtAlertSettingsFromRow(r: SettingsRow | null | undefined): MgmtAlertSettings {
  const d = DEFAULT_MGMT_ALERT_SETTINGS;
  const pos = (v: unknown, fallback: number) => {
    const x = Number(v);
    return v === null || v === undefined || v === "" || !Number.isFinite(x) || x <= 0
      ? fallback
      : x;
  };
  return {
    reportLateDays: pos(r?.alert_report_late_days, d.reportLateDays),
    revenueTargetPct: pos(r?.alert_revenue_target_pct, d.revenueTargetPct),
    revenueTargetDays: pos(r?.alert_revenue_target_days, d.revenueTargetDays),
    bandMinPatients: pos(r?.alert_band_min_patients, d.bandMinPatients),
  };
}

const whole = (label: string, min: number, max: number) =>
  z.coerce
    .number({ message: `${label} must be a number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);

/** The same limits as the database checks. */
export const mgmtAlertSettingsSchema = z.object({
  alert_report_late_days: whole("Days without a report", 1, 60),
  alert_revenue_target_pct: z.coerce
    .number({ message: "Percent of target must be a number." })
    .gt(0, "Percent of target must be more than 0.")
    .max(100, "Percent of target must be at most 100.")
    .refine(
      (v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6,
      "Percent of target: at most two decimals.",
    ),
  alert_revenue_target_days: whole("Covered days behind target", 1, 31),
  alert_band_min_patients: whole("Minimum patients", 1, 100_000),
});

// ---------------------------------------------------------------------------
// Inputs (fin_mgmt_alert_inputs, parsed)
// ---------------------------------------------------------------------------

export type MgmtAlertInputs = {
  month: string;
  /** The latest day any committed upload covers; null when nothing was ever committed. */
  lastCovered: string | null;
  coverage: DateRange[];
  /** Net revenue per day, branch and department (flash rows with no doctor and no patient counts). */
  rows: FlashRow[];
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function parseMgmtAlertInputs(raw: unknown): MgmtAlertInputs {
  const r =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const last = typeof r.last_covered === "string" ? r.last_covered.slice(0, 10) : null;
  const coverage = (Array.isArray(r.coverage) ? r.coverage : [])
    .map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      return { from: String(o.from ?? ""), to: String(o.to ?? "") };
    })
    .filter((x) => ISO.test(x.from) && ISO.test(x.to));
  return {
    month: String(r.month ?? "").slice(0, 10),
    lastCovered: last && ISO.test(last) ? last : null,
    coverage,
    rows: parseFlashRows(r),
  };
}

// ---------------------------------------------------------------------------
// Rule 1: the Unite report is late
// ---------------------------------------------------------------------------

/**
 * Late when no committed upload covers any of the `lateDays` days before today (today − N … today − 1). Quiet until the
 * first upload was ever committed (the report is not in use yet: no start-up false alarm), and on unreadable dates.
 */
export function reportIsLate(i: {
  today: string;
  lastCovered: string | null;
  lateDays: number;
}): boolean {
  const today = dayNumber(i.today);
  const last = dayNumber(i.lastCovered);
  if (today === null || last === null || !(i.lateDays >= 1)) return false;
  return last < today - i.lateDays;
}

// ---------------------------------------------------------------------------
// Rule 2: revenue behind target
// ---------------------------------------------------------------------------

/** The covered days inside `month`, sorted, each once. */
export function coveredDays(month: string, coverage: readonly DateRange[]): string[] {
  const days = new Set<string>();
  for (const r of coverage)
    for (const d of eachDay(r.from, r.to)) if (monthOf(d) === month) days.add(d);
  return [...days].sort();
}

export type ScopeProgress = {
  scope: string;
  /** Cumulative actual and target after each covered day (2-decimal amounts, as the flash report shows them). */
  points: { day: string; actual: number; target: number }[];
};

const cents = (v: number) => Math.round(v * 100);

/** Strictly below `pct` % of the target (exactly at the threshold is not behind). Integer arithmetic. */
export function isBehind(actual: number, target: number, pct: number): boolean {
  if (!(target > 0)) return false;
  return cents(actual) * 10_000 < Math.round(pct * 100) * cents(target);
}

/**
 * Month-to-date progress per scope over the covered days only: each covered day is one flash period (from = to = that
 * day), so lines, the core total and its target (the explicit total row, else the sum of the core lines' targets)
 * follow lib/finance/flash.ts; the target therefore grows by one daily rate per covered day, never per calendar day.
 * Scopes: 'total' (the flash Total, i.e. the core lines) and 'line:<code>' for each branch line with a revenue target.
 * A scope with no target is left out (nothing to compare with).
 */
export function revenueProgress(input: {
  month: string;
  rows: readonly FlashRow[];
  lines: readonly ReportLine[];
  targets: readonly RevenueTarget[];
  coverage: readonly DateRange[];
}): ScopeProgress[] {
  const days = coveredDays(input.month, input.coverage);
  if (days.length === 0) return [];
  const branchLines = effectiveLines(input.lines, input.rows).filter(
    (l) => l.matchKind === "branch",
  );
  const acc = new Map<string, ScopeProgress>();
  const add = (scope: string, day: string, actual: number, target: number | null) => {
    if (target === null) return;
    const p = acc.get(scope) ?? { scope, points: [] };
    const prev = p.points[p.points.length - 1];
    p.points.push({
      day,
      actual: (cents(prev?.actual ?? 0) + cents(actual)) / 100,
      target: (cents(prev?.target ?? 0) + cents(target)) / 100,
    });
    acc.set(scope, p);
  };
  for (const day of days) {
    const s = buildFlashSummary({
      rows: input.rows,
      lines: input.lines,
      targets: input.targets,
      from: day,
      to: day,
    });
    add("total", day, s.coreTotal.revenue.actual, s.coreTotal.revenue.target);
    const all = [...s.lines, ...s.otherLines];
    for (const l of branchLines) {
      const r = all.find((x) => x.code === l.code);
      if (r) add(`line:${l.code}`, day, r.revenue.actual, r.revenue.target);
    }
  }
  // a scope must have its target on every covered day (targets are per month, so it does, or it has none)
  return [...acc.values()].filter((p) => p.points.length === days.length);
}

/** Scopes behind target on each of the last `days` covered days (fewer covered days than that: none). */
export function revenueBehindScopes(
  progress: readonly ScopeProgress[],
  pct: number,
  days: number,
): string[] {
  if (!(days >= 1)) return [];
  return progress
    .filter(
      (p) =>
        p.points.length >= days &&
        p.points.slice(-days).every((x) => isBehind(x.actual, x.target, pct)),
    )
    .map((p) => p.scope);
}

// ---------------------------------------------------------------------------
// Rule 3: revenue per patient below band
// ---------------------------------------------------------------------------

/**
 * Doctors (distinct doctor keys) with a row in the Below Target band, judged by bandOf on the report's own thresholds,
 * and at least `minPatients` patients in that row. Null until the month is fully covered by committed report data.
 */
export function doctorsBelowBand(report: DoctorPerformance, minPatients: number): number | null {
  if (!report.coverage.full) return null;
  const below = new Set<string>();
  for (const d of report.departments)
    for (const r of d.doctorRows)
      if (r.patients >= minPatients && bandOf(r.revenuePerPatient, report.settings) === "below")
        below.add(r.doctorKey);
  return below.size;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * What to raise (active, not open) and what to clear (open, its rule was evaluated this run, it clears, and it is no
 * longer active). A rule whose inputs could not be read is left alone. Raising is then claimed atomically in SQL.
 */
export function alertTransitions(
  active: readonly AlertKey[],
  open: readonly AlertKey[],
  evaluated: ReadonlySet<MgmtAlertRule>,
): { raise: AlertKey[]; clear: AlertKey[] } {
  const openIds = new Set(open.map(keyId));
  const activeIds = new Set(active.map(keyId));
  const seen = new Set<string>();
  const raise = active.filter((k) => {
    const id = keyId(k);
    if (openIds.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const clear = open.filter(
    (k) => evaluated.has(k.rule) && RULE_CLEARS[k.rule] && !activeIds.has(keyId(k)),
  );
  return { raise, clear };
}

// ---------------------------------------------------------------------------
// In-app copy (push and e-mail never use it)
// ---------------------------------------------------------------------------

export const MGMT_ALERT_EVENTS: Record<MgmtAlertRule, string> = {
  report_late: "finance.report_late",
  revenue_behind: "finance.revenue_behind",
  band_below: "finance.band_below",
};

export function reportLateMessage(lateDays: number) {
  return {
    title: "The Unite collection report is late",
    body: `No committed upload covers any of the last ${lateDays} days. Open Finance, Upload to add it.`,
  };
}

export function revenueBehindMessage(
  scopes: readonly string[],
  s: Pick<MgmtAlertSettings, "revenueTargetPct" | "revenueTargetDays">,
) {
  const total = scopes.includes("total");
  const lines = scopes.filter((x) => x.startsWith("line:")).length;
  const what = [
    total ? "the total" : null,
    lines > 0 ? `${lines} branch line${lines === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return {
    title: "Revenue is behind target",
    body: `Month-to-date revenue for ${what} has been below ${s.revenueTargetPct}% of the target (scaled to the days the report covers) for the last ${s.revenueTargetDays} covered days. Open Finance, Flash report.`,
  };
}

export function bandBelowMessage(count: number, month: string) {
  return {
    title: "Doctors below the revenue-per-patient band",
    body: `${count} doctor${count === 1 ? " was" : "s were"} below the revenue-per-patient band in ${monthTitle(month)}.`,
  };
}
