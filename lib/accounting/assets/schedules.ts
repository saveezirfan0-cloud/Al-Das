import { addMonths, monthsBetween } from "./depreciation";

/**
 * Prepayment, accrual and deferred revenue schedules (Phase 22H), pure. A schedule releases `total` evenly over `months`
 * months from `startMonth`; each month is the rounded cumulative minus the previous one, so the releases add up to the
 * total exactly. Ordinary schedules catch up like depreciation (the cumulative to the month minus what was posted
 * before). A reversing accrual posts its monthly amount every month and the ledger reverses it on the 1st of the next
 * month, so it never catches up.
 */

export type ScheduleKind = "prepayment" | "accrual" | "deferred_revenue";

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  prepayment: "Prepayment",
  accrual: "Accrual",
  deferred_revenue: "Deferred revenue",
};

/** Which side each ledger of a schedule is booked on, for people. */
export const SCHEDULE_POSTING: Record<ScheduleKind, string> = {
  prepayment: "Each month: debit the expense, credit the prepayment.",
  accrual: "Each month: debit the expense, credit the accrued liability.",
  deferred_revenue: "Each month: debit the deferred revenue, credit the income.",
};

export type ScheduleBasis = {
  total: number;
  months: number;
  /** YYYY-MM-01 */
  startMonth: string;
};

const toFils = (n: number) => Math.round(Number((n * 100).toPrecision(15)));
const fromFils = (f: number) => f / 100;

function cumulativeFils(s: ScheduleBasis, month: string): number {
  const k = monthsBetween(s.startMonth, month);
  if (!(k >= 0)) return 0;
  const done = Math.min(k + 1, s.months);
  return Math.round((toFils(s.total) * done) / s.months);
}

/** Released up to and including `month`. */
export function scheduleCumulative(s: ScheduleBasis, month: string): number {
  return fromFils(cumulativeFils(s, month));
}

/** The month's own share (0 outside the schedule). */
export function scheduleMonthAmount(s: ScheduleBasis, month: string): number {
  return fromFils(cumulativeFils(s, month) - cumulativeFils(s, addMonths(month, -1)));
}

/** The release in a run: the cumulative to the month minus what earlier posted months released. */
export function scheduleRunAmount(s: ScheduleBasis, month: string, postedBefore: number): number {
  return fromFils(Math.max(0, cumulativeFils(s, month) - toFils(postedBefore)));
}

export function scheduleLastMonth(s: ScheduleBasis): string {
  return addMonths(s.startMonth, s.months - 1);
}

export function scheduleProblem(s: ScheduleBasis): string | null {
  if (!(s.total > 0) || !Number.isFinite(s.total)) return "The total must be above zero.";
  if (!Number.isInteger(s.months) || s.months < 1 || s.months > 600)
    return "Spread it over 1 to 600 months.";
  if (!/^\d{4}-\d{2}-01$/.test(s.startMonth)) return "Choose the first month.";
  return null;
}
