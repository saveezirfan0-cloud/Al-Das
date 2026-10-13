/**
 * The one shape every Phase 22G statement is turned into (pure). The page renders it, the Excel and PDF exports render
 * the same object, so a figure is identical on screen and in a download. Values are plain numbers (AED, two decimals),
 * percentages as numbers (12.5 = 12.5%), or text.
 */

export type ReportRowKind = "heading" | "group" | "ledger" | "subtotal" | "total" | "note";

export type ReportRow = {
  label: string;
  code?: string | null;
  depth: number;
  kind: ReportRowKind;
  values: Array<number | string | null>;
  /** drill-down (the general ledger, a journal); only added when the viewer may open it */
  href?: string | null;
  flag?: "adverse" | "warning" | null;
  /** overrides the column formats for this row (a margin row in a money table) */
  format?: ColumnFormat;
};

export type ColumnFormat = "money" | "percent" | "number" | "text" | "ratio";

export type ReportTable = {
  title?: string;
  /** header of the first (label) column */
  labelHeader?: string;
  /** value column headers */
  columns: string[];
  /** per value column; money when missing */
  formats?: ColumnFormat[];
  rows: ReportRow[];
  /** shown when there are no rows */
  empty?: string;
  /** leave out of the PDF (long supporting lists stay in Excel) */
  pdf?: boolean;
};

export type ReportDoc = {
  title: string;
  subtitle: string;
  /** figures not final: a month in range is not closed or locked */
  provisional: boolean;
  /** "Working paper, not a tax return" and the like */
  workingPaper?: string | null;
  warnings: string[];
  tables: ReportTable[];
  notes: string[];
};

/** Integer cents, so sums never drift. */
export const cents = (n: number | string | null | undefined): number =>
  Math.round(Number(n ?? 0) * 100);
export const fromCents = (c: number): number => c / 100;

/** A ratio rounded to two decimals, or null when the denominator is zero. */
export function ratio(num: number, den: number, digits = 2): number | null {
  if (!Number.isFinite(num) || !Number.isFinite(den) || Math.abs(den) < 0.005) return null;
  const f = 10 ** digits;
  return Math.round((num / den) * f) / f;
}

/** A percentage with one decimal (12.5 = 12.5%), or null when the denominator is zero. */
export function pct(num: number, den: number): number | null {
  const r = ratio(num * 100, den, 1);
  return r;
}

/** Text for one value in a given format (pages, PDF). */
export function formatValue(
  v: number | string | null | undefined,
  f: ColumnFormat = "money",
): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "";
  switch (f) {
    case "percent":
      return `${v.toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;
    case "number":
      return v.toLocaleString("en-GB", { maximumFractionDigits: 0 });
    case "ratio":
      return v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case "text":
      return String(v);
    default: {
      const s = Math.abs(v).toLocaleString("en-GB", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return v < 0 ? `(${s})` : s;
    }
  }
}

/** "1 Jul 2026" */
export function dateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function rangeLabel(from: string, to: string): string {
  return `${dateLabel(from)} to ${dateLabel(to)}`;
}

/** "Jul 2026" for 2026-07 */
export function monthLabel(ym: string): string {
  const d = new Date(`${ym.slice(0, 7)}-01T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ym;
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (s: string) => new Date(`${s}T00:00:00Z`);

function addMonths(s: string, n: number): string {
  const d = utc(s);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return iso(t);
}

function lastOfMonth(s: string): string {
  const d = utc(s);
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** Whole calendar months: from the 1st of one month to the last day of another. */
export function isWholeMonths(from: string, to: string): boolean {
  return from.endsWith("-01") && lastOfMonth(to) === to && from <= to;
}

/**
 * The comparison range for a P&L: the same length immediately before (whole months stay whole months), or the same
 * dates a year earlier (29 February becomes the 28th).
 */
export function comparisonRange(
  from: string,
  to: string,
  kind: "previous" | "last_year",
): { from: string; to: string } {
  if (kind === "last_year") {
    const back = (s: string) => {
      const d = utc(s);
      const t = new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1));
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
      t.setUTCDate(Math.min(d.getUTCDate(), last));
      return iso(t);
    };
    // a range ending on a month end keeps ending on a month end (28 Feb 2027 -> 29 Feb 2028 is not needed backwards)
    const t = back(to);
    return { from: back(from), to: lastOfMonth(to) === to ? lastOfMonth(t) : t };
  }
  if (isWholeMonths(from, to)) {
    const f = utc(from);
    const t = utc(to);
    const months =
      (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
    const pFrom = addMonths(from, -months);
    return { from: pFrom, to: iso(new Date(utc(from).getTime() - 86_400_000)) };
  }
  const days = Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000) + 1;
  const pTo = iso(new Date(utc(from).getTime() - 86_400_000));
  const pFrom = iso(new Date(utc(from).getTime() - days * 86_400_000));
  return { from: pFrom, to: pTo };
}

/** Days in a range, both ends included. */
export function daysIn(from: string, to: string): number {
  return Math.round((utc(to).getTime() - utc(from).getTime()) / 86_400_000) + 1;
}

/** The same date a year earlier (29 February becomes the 28th). */
export function yearEarlier(s: string): string {
  return comparisonRange(s, s, "last_year").from;
}
