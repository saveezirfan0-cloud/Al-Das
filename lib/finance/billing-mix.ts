import { csvEscape } from "@/lib/csv";
import { addDays, dayNumber } from "@/lib/documents/expiry";
import { delta } from "@/lib/finance/format";

/**
 * Slice 20K (pure): how each doctor bills (service-category mix, insurance vs self-pay, revenue per patient) against
 * the clinic as a whole, and revenue per week or month next to the same period last year.
 *
 * Inputs are the jsonb of SQL `fin_billing_mix` and `fin_revenue_trend` (counts and amounts only, no patient data).
 * Shares are of net revenue. A share or comparison that would divide by zero is null, never 0 or Infinity.
 */

export const PAYER_KINDS = ["insurance", "self_pay", "other"] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];
export const PAYER_LABELS: Record<PayerKind, string> = {
  insurance: "Insurance",
  self_pay: "Self-pay",
  other: "Other",
};

export const UNMAPPED = "Unmapped";

export type MixRow = {
  doctorId: string | null;
  doctorName: string | null;
  department: string | null;
  net: number;
  invoices: number;
  lines: number;
  patients: number;
  payer: Record<PayerKind, { net: number; invoices: number }>;
  /** net by service category */
  categories: Record<string, number>;
};

export type BillingMix = {
  doctorBasis: "ordering" | "performing" | null;
  /** the whole clinic (every doctor, and invoices with none); null when nothing was billed */
  clinic: MixRow | null;
  rows: MixRow[];
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const text = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

function parseRow(json: unknown): MixRow {
  const o = (json ?? {}) as Record<string, unknown>;
  const payer = (o.payer ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const categories: Record<string, number> = {};
  const cats = o.categories;
  if (cats && typeof cats === "object" && !Array.isArray(cats))
    for (const [k, v] of Object.entries(cats as Record<string, unknown>)) categories[k] = num(v);
  return {
    doctorId: text(o.doctor_id),
    doctorName: text(o.doctor_name),
    department: text(o.department),
    net: num(o.net),
    invoices: num(o.invoices),
    lines: num(o.lines),
    patients: num(o.patients),
    payer: Object.fromEntries(
      PAYER_KINDS.map((k) => [k, { net: num(payer[k]?.net), invoices: num(payer[k]?.invoices) }]),
    ) as MixRow["payer"],
    categories,
  };
}

export function parseBillingMix(json: unknown): BillingMix {
  const o = (json ?? {}) as Record<string, unknown>;
  const basis = o.doctor_basis;
  return {
    doctorBasis: basis === "ordering" || basis === "performing" ? basis : null,
    clinic: o.clinic && typeof o.clinic === "object" ? parseRow(o.clinic) : null,
    rows: Array.isArray(o.rows) ? o.rows.map(parseRow) : [],
  };
}

/** part / whole, or null when the whole is not positive. */
export function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Categories in the order of the clinic's net revenue (largest first), Unmapped last. */
export function categoryOrder(mix: BillingMix): string[] {
  const totals = new Map<string, number>();
  for (const r of [mix.clinic, ...mix.rows])
    if (r) for (const [k, v] of Object.entries(r.categories)) if (!totals.has(k)) totals.set(k, v);
  // the clinic row comes first, so its totals win; categories only a doctor has (cannot happen from SQL) still appear
  return [...totals.keys()].sort((a, b) => {
    if (a === UNMAPPED || b === UNMAPPED) return a === UNMAPPED ? (b === UNMAPPED ? 0 : 1) : -1;
    return (totals.get(b) ?? 0) - (totals.get(a) ?? 0) || a.localeCompare(b);
  });
}

export type MixView = MixRow & {
  /** revenue per patient */
  arpp: number | null;
  linesPerInvoice: number | null;
  insuranceShare: number | null;
  /** share of net per category (0 to 1); null when net is not positive */
  categoryShares: Record<string, number | null>;
  /** this row's category share minus the clinic's, in percentage points (one decimal) */
  difference: Record<string, number | null>;
  /** the category where this row differs most from the clinic, if any */
  largest: { category: string; points: number } | null;
};

function view(r: MixRow, clinic: MixRow | null, categories: readonly string[]): MixView {
  const categoryShares: Record<string, number | null> = {};
  const difference: Record<string, number | null> = {};
  let largest: MixView["largest"] = null;
  for (const c of categories) {
    const s = share(r.categories[c] ?? 0, r.net);
    const base = clinic ? share(clinic.categories[c] ?? 0, clinic.net) : null;
    categoryShares[c] = s;
    const d = s === null || base === null ? null : Math.round((s - base) * 1000) / 10;
    difference[c] = d;
    if (d !== null && d !== 0 && (largest === null || Math.abs(d) > Math.abs(largest.points)))
      largest = { category: c, points: d };
  }
  return {
    ...r,
    arpp: r.patients > 0 ? r.net / r.patients : null,
    linesPerInvoice: r.invoices > 0 ? r.lines / r.invoices : null,
    insuranceShare: share(r.payer.insurance.net, r.net),
    categoryShares,
    difference,
    largest,
  };
}

/** Per-doctor figures with shares and the difference from the clinic's own mix. */
export function describeMix(mix: BillingMix): {
  categories: string[];
  clinic: MixView | null;
  rows: MixView[];
} {
  const categories = categoryOrder(mix);
  return {
    categories,
    clinic: mix.clinic ? view(mix.clinic, mix.clinic, categories) : null,
    rows: mix.rows.map((r) => view(r, mix.clinic, categories)),
  };
}

// ---------------------------------------------------------------------------
// Seasonality
// ---------------------------------------------------------------------------

export const TREND_GRAINS = ["month", "week"] as const;
export type TrendGrain = (typeof TREND_GRAINS)[number];

type Figures = { net: number; invoices: number; patients: number };

export type TrendRow = Figures & {
  /** first day of the week (Monday) or month */
  period: string;
  /** the part of the period inside the chosen range */
  from: string;
  to: string;
  /** the same period a year earlier; null when the invoices on record do not reach back that far */
  lastYear: Figures | null;
  /** net against last year, percent with one decimal; null without a usable last-year figure */
  changePct: number | null;
};

export type Trend = { grain: TrendGrain; historyFrom: string | null; rows: TrendRow[] };

export function parseTrend(json: unknown): Trend {
  const o = (json ?? {}) as Record<string, unknown>;
  const rows = (Array.isArray(o.rows) ? o.rows : []).map((x) => {
    const r = (x ?? {}) as Record<string, unknown>;
    const lastYear =
      r.ly_covered === true
        ? { net: num(r.ly_net), invoices: num(r.ly_invoices), patients: num(r.ly_patients) }
        : null;
    const net = num(r.net);
    return {
      period: String(r.period ?? ""),
      from: String(r.from ?? r.period ?? ""),
      to: String(r.to ?? r.period ?? ""),
      net,
      invoices: num(r.invoices),
      patients: num(r.patients),
      lastYear,
      changePct: lastYear ? delta(net, lastYear.net).pct : null,
    };
  });
  return {
    grain: o.grain === "week" ? "week" : "month",
    historyFrom: text(o.history_from),
    rows,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 2026" for a month, "w/c 5 Oct 2026" for a week. */
export function periodLabel(grain: TrendGrain, period: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(period);
  if (!m) return period;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return grain === "month" ? `${month} ${m[1]}` : `w/c ${Number(m[3])} ${month} ${m[1]}`;
}

/**
 * Net and invoices for the whole range and for the same periods last year (null unless every period has last year's
 * figures). Patients are left out: they are distinct within a period, so they cannot be added across periods.
 */
export function trendTotals(rows: readonly TrendRow[]): {
  current: { net: number; invoices: number };
  lastYear: { net: number; invoices: number } | null;
  changePct: number | null;
} {
  const sum = (xs: readonly Figures[]) => ({
    net: Math.round(xs.reduce((a, r) => a + r.net, 0) * 100) / 100,
    invoices: xs.reduce((a, r) => a + r.invoices, 0),
  });
  const current = sum(rows);
  const covered = rows.length > 0 && rows.every((r) => r.lastYear !== null);
  const lastYear = covered ? sum(rows.map((r) => r.lastYear!)) : null;
  return { current, lastYear, changePct: lastYear ? delta(current.net, lastYear.net).pct : null };
}

// ---------------------------------------------------------------------------
// CSV (numbers raw, text through csvEscape so a cell cannot start a formula)
// ---------------------------------------------------------------------------

const fixed = (n: number | null, d = 2) => (n === null ? "" : n.toFixed(d));
const pct = (n: number | null) => (n === null ? "" : (n * 100).toFixed(1));
const line = (cells: string[]) => cells.join(",");

export function billingMixCsv(mix: BillingMix): string {
  const { categories, clinic, rows } = describeMix(mix);
  const head = [
    "Doctor ID",
    "Doctor",
    "Department",
    "Net",
    "Invoices",
    "Patients",
    "Revenue per patient",
    "Lines per invoice",
    ...PAYER_KINDS.flatMap((k) => [`${PAYER_LABELS[k]} net`, `${PAYER_LABELS[k]} invoices`]),
    "Insurance share %",
    ...categories.flatMap((c) => [`${c} net`, `${c} %`, `${c} vs clinic (pts)`]),
  ].map(csvEscape);
  const body = [...rows, ...(clinic ? [clinic] : [])].map((r) => {
    const isClinic = r === clinic;
    return line([
      csvEscape(isClinic ? "ALL" : (r.doctorId ?? "")),
      csvEscape(isClinic ? "All doctors" : (r.doctorName ?? (r.doctorId ? "" : "No doctor"))),
      csvEscape(r.department ?? ""),
      fixed(r.net),
      String(r.invoices),
      String(r.patients),
      fixed(r.arpp),
      fixed(r.linesPerInvoice),
      ...PAYER_KINDS.flatMap((k) => [fixed(r.payer[k].net), String(r.payer[k].invoices)]),
      pct(r.insuranceShare),
      ...categories.flatMap((c) => [
        fixed(r.categories[c] ?? 0),
        pct(r.categoryShares[c] ?? null),
        isClinic ? "" : fixed(r.difference[c] ?? null, 1),
      ]),
    ]);
  });
  return [line(head), ...body].join("\r\n") + "\r\n";
}

export function trendCsv(trend: Trend): string {
  const head = [
    "Period",
    "From",
    "To",
    "Net",
    "Invoices",
    "Patients",
    "Last year net",
    "Last year invoices",
    "Last year patients",
    "Change %",
  ];
  const body = trend.rows.map((r) =>
    line([
      csvEscape(periodLabel(trend.grain, r.period)),
      r.from,
      r.to,
      fixed(r.net),
      String(r.invoices),
      String(r.patients),
      r.lastYear ? fixed(r.lastYear.net) : "",
      r.lastYear ? String(r.lastYear.invoices) : "",
      r.lastYear ? String(r.lastYear.patients) : "",
      r.changePct === null ? "" : String(r.changePct),
    ]),
  );
  return [line(head), ...body].join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------------------
// Filters (shared by the page and the CSV route)
// ---------------------------------------------------------------------------

/** The longest range the trend accepts (SQL refuses more). */
export const MAX_RANGE_DAYS = 1100;

export type AnalyticsFilters = {
  from: string;
  to: string;
  branch: string | null;
  grain: TrendGrain;
};

/** The first day of the month `months` before the month of `date` (YYYY-MM-DD). */
export function monthStartBefore(date: string, months: number): string {
  const total = Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/**
 * Range (default: the 12 calendar months up to today, the current one included), branch code and grain. A reversed
 * range is swapped; one longer than MAX_RANGE_DAYS keeps its end and is shortened.
 */
export function readAnalyticsFilters(
  get: (key: string) => string | null | undefined,
  today: string,
): AnalyticsFilters {
  const date = (k: string) => {
    const v = get(k) ?? "";
    return dayNumber(v) === null ? null : v;
  };
  let to = date("to") ?? today;
  let from = date("from") ?? monthStartBefore(to, 11);
  if (from > to) [from, to] = [to, from];
  if (dayNumber(to)! - dayNumber(from)! > MAX_RANGE_DAYS) from = addDays(to, -MAX_RANGE_DAYS)!;
  const branch =
    (get("branch") ?? "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4)
      .toUpperCase() || null;
  return { from, to, branch, grain: get("grain") === "week" ? "week" : "month" };
}
