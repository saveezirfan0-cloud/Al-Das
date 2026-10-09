import { URGENT_CATEGORIES, type TriggerCategory } from "@/lib/clinical/category";
import { Needs } from "@/lib/clinical/settings";

/** The clinic's working week and closures (the appointments booking-rule calendar). */
export type ClinicCalendar = {
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  workingWeekdays: readonly number[];
  /** YYYY-MM-DD */
  holidays: readonly string[];
};

const DAY = 86_400_000;

function toDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function toStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isoWeekday(d: Date): number {
  return d.getUTCDay() === 0 ? 7 : d.getUTCDay();
}

export function isWorkingDay(date: string, cal: ClinicCalendar): boolean {
  return cal.workingWeekdays.includes(isoWeekday(toDate(date))) && !cal.holidays.includes(date);
}

/** The n-th working day after `from` (the start day itself is never counted). */
export function addWorkdays(from: string, n: number, cal: ClinicCalendar): string {
  let d = toDate(from);
  let left = n;
  for (let guard = 0; left > 0 && guard < 400; guard++) {
    d = new Date(d.getTime() + DAY);
    if (isWorkingDay(toStr(d), cal)) left--;
  }
  return toStr(d);
}

export function addDays(from: string, n: number): string {
  return toStr(new Date(toDate(from).getTime() + n * DAY));
}

/** Working days after `from` up to and including `to`. */
export function workdaysBetween(from: string, to: string, cal: ClinicCalendar): number {
  let count = 0;
  for (let d = toDate(from).getTime() + DAY; d <= toDate(to).getTime(); d += DAY)
    if (isWorkingDay(toStr(new Date(d)), cal)) count++;
  return count;
}

const REVIEW_IN = /review\s+in\s+(\d{1,3})\s*(day|days|week|weeks|wk|wks)\b/i;

/**
 * R-10: urgent categories are due the next working day, everything else two working days later, on
 * the clinic's real working week. A plan that says "review in 5 days" sets the due date to that many
 * days instead (OQ-40), up to followup_review_cap_days. A timing setting that isn't signed off leaves
 * the date empty rather than guessed.
 */
export function followUpDueDate(
  visitDate: string,
  category: TriggerCategory,
  plan: string | null | undefined,
  cal: ClinicCalendar,
  need: Needs,
): string | null {
  const review = REVIEW_IN.exec(plan ?? "");
  if (review) {
    const cap = need.num("followup_review_cap_days");
    const n = Number(review[1]) * (/^w/i.test(review[2]) ? 7 : 1);
    if (cap !== undefined && n > 0 && n <= cap) return addDays(visitDate, n);
  }
  const days = need.num(
    URGENT_CATEGORIES.includes(category) ? "followup_days_urgent" : "followup_days_standard",
  );
  return days === undefined ? null : addWorkdays(visitDate, days, cal);
}

/** R-11: one live follow-up per visit and category. */
export function dedupeKey(visitExternalId: string, category: TriggerCategory): string {
  return `${visitExternalId}-${category}`;
}
