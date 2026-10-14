import type { VoucherType } from "@/lib/accounting/journal";

/**
 * Fiscal years and journal numbers (pure), mirroring app.acc_fy_start / acc_fy_code / acc_format_number in SQL.
 * Owner decision (13 Oct 2026): the fiscal year runs July to June by default; each entity can start in any month
 * (1 = the calendar year).
 */

export const DEFAULT_FY_START_MONTH = 7;

const pad2 = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad2(m)}-${pad2(d)}`;

function parts(date: string): { y: number; m: number; d: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error("expected YYYY-MM-DD");
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Last day of a month (1..12). */
export function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** First and last day of the fiscal year holding `date`. */
export function fiscalYearOf(
  startMonth: number,
  date: string,
): { start: string; end: string; code: string; label: string } {
  const { y, m } = parts(date);
  const startYear = m >= startMonth ? y : y - 1;
  const start = iso(startYear, startMonth, 1);
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  const endYear = startMonth === 1 ? startYear : startYear + 1;
  const end = iso(endYear, endMonth, lastDay(endYear, endMonth));
  const code = fiscalYearCode(start);
  return { start, end, code, label: `FY ${code}` };
}

/** "2026" for a calendar year, "2026-27" for a year starting in any other month (from the year's first day). */
export function fiscalYearCode(start: string): string {
  const { y, m } = parts(start);
  return m === 1 ? String(y) : `${y}-${pad2((y + 1) % 100)}`;
}

export const DEFAULT_PREFIXES: Record<VoucherType, string> = {
  journal: "JV",
  contra: "CTR",
  payment: "PMT",
  receipt: "RCT",
  sales: "SAL",
  purchase: "PUR",
  credit_note: "CRN",
  debit_note: "DBN",
  opening: "OPB",
};

/** JV/2026-27/00001: prefix, fiscal year, at least five digits. */
export function formatJournalNumber(prefix: string, fyCode: string, n: number): string {
  return `${prefix}/${fyCode}/${String(n).padStart(5, "0")}`;
}

/** The month a period covers, as people read it: "Jul 2026", or "FY 2025-26 adjustments" for the 13th period. */
export function periodLabel(year: number, month: number, fyLabel?: string | null): string {
  if (month === 13) return `${fyLabel ?? `Year ${year}`} adjustments`;
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${names[month - 1] ?? "?"} ${year}`;
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
