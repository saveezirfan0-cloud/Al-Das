/**
 * Lifecycle stage of a contact (docs/45 §3). Derived from data, never typed. Pure.
 *
 *  - lead:        no Unite PIN and no known visit
 *  - new_patient: first visit within `newPatientDays` of today
 *  - active:      last visit within `activeMonths` of today
 *  - lapsed:      last visit older than `activeMonths`
 *  - unknown:     registered (has a PIN) but no usable visit date. Fails closed: never guessed as active or lapsed.
 *
 * The thresholds are org settings (see lib/contacts/lifecycle-settings.ts), never constants at the call site.
 */

export const LIFECYCLE_STAGES = ["lead", "new_patient", "active", "lapsed", "unknown"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];

export const LIFECYCLE_LABELS: Record<LifecycleStage, string> = {
  lead: "Lead",
  new_patient: "New patient",
  active: "Active",
  lapsed: "Lapsed",
  unknown: "Not enough visit data",
};

export type LifecycleThresholds = { newPatientDays: number; activeMonths: number };

export const DEFAULT_LIFECYCLE_THRESHOLDS: LifecycleThresholds = {
  newPatientDays: 90,
  activeMonths: 18,
};

export type LifecycleInput = {
  /** contacts.external_id (the Unite PIN), blank counts as none. */
  unitePin: string | null;
  /** YYYY-MM-DD of the earliest and latest known visit (v_contact_visit_stats), or null. */
  firstVisitDate: string | null;
  lastVisitDate: string | null;
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function ymd(value: string | null): Date | null {
  if (!value || !YMD.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : d;
}

/** The date `months` calendar months before `d` (UTC, day clamped to the month's end). */
function monthsBefore(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() - months;
  const target = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target;
}

/** `today` is a YYYY-MM-DD in the org's timezone (the caller decides the day). */
export function lifecycleStage(
  input: LifecycleInput,
  today: string,
  thresholds: LifecycleThresholds = DEFAULT_LIFECYCLE_THRESHOLDS,
): LifecycleStage {
  const now = ymd(today);
  const last = ymd(input.lastVisitDate);
  const first = ymd(input.firstVisitDate);
  const hasPin = !!input.unitePin?.trim();
  if (!now) return "unknown";
  if (!last && !first) return hasPin ? "unknown" : "lead";
  // A visit date after today is bad data, not a patient from the future.
  if ((last && last > now) || (first && first > now)) return "unknown";
  const newCutoff = new Date(now.getTime() - thresholds.newPatientDays * 86_400_000);
  const activeCutoff = monthsBefore(now, thresholds.activeMonths);
  if (first && first >= newCutoff && (!last || last >= activeCutoff)) return "new_patient";
  if (last) return last >= activeCutoff ? "active" : "lapsed";
  // Only a first-visit date: the latest visit is at least that recent.
  return first && first >= activeCutoff ? "active" : "lapsed";
}
