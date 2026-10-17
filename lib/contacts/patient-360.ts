/**
 * Pure helpers for the Patient 360 page (docs/45 section 4). No I/O, no clinical text.
 */
import {
  DEFAULT_LIFECYCLE_THRESHOLDS,
  lifecycleStage,
  type LifecycleStage,
  type LifecycleThresholds,
} from "@/lib/contacts/lifecycle";

/** Whole years between a YYYY-MM-DD birth date and `today` (YYYY-MM-DD); null for a missing, invalid or future date. */
export function ageInYears(dob: string | null, today: string): number | null {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const b = dob ? re.exec(dob) : null;
  const t = re.exec(today);
  if (!b || !t) return null;
  const [by, bm, bd] = [Number(b[1]), Number(b[2]), Number(b[3])];
  const [ty, tm, td] = [Number(t[1]), Number(t[2]), Number(t[3])];
  if (bm < 1 || bm > 12 || bd < 1 || bd > 31) return null;
  let age = ty - by;
  if (tm < bm || (tm === bm && td < bd)) age -= 1;
  return age < 0 || age > 130 ? null : age;
}

/** "3 years", "7 months" for a baby; null when unknown. */
export function ageLabel(dob: string | null, today: string): string | null {
  const years = ageInYears(dob, today);
  if (years === null) return null;
  if (years >= 2) return `${years} years`;
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const b = re.exec(dob ?? "");
  const t = re.exec(today);
  if (!b || !t) return null;
  const months =
    (Number(t[1]) - Number(b[1])) * 12 +
    (Number(t[2]) - Number(b[2])) -
    (Number(t[3]) < Number(b[3]) ? 1 : 0);
  return months <= 0 ? "under 1 month" : `${months} month${months === 1 ? "" : "s"}`;
}

export type ConsentChip = {
  key: "whatsapp" | "marketing" | "clinical";
  label: string;
  tone: "ok" | "warn" | "off";
};

/** The three consent chips of the header, from the contact's own consent columns. */
export function consentChips(c: {
  phone_e164: string | null;
  whatsapp_declined_at: string | null;
  promotions_opt_in: boolean;
  stop_marketing: boolean;
  clinical_messaging_consent: boolean;
}): ConsentChip[] {
  const whatsapp: ConsentChip = c.whatsapp_declined_at
    ? { key: "whatsapp", label: "WhatsApp: declined", tone: "warn" }
    : c.phone_e164
      ? { key: "whatsapp", label: "WhatsApp: reachable", tone: "ok" }
      : { key: "whatsapp", label: "WhatsApp: no number", tone: "off" };
  const marketing: ConsentChip = c.stop_marketing
    ? { key: "marketing", label: "Marketing: stopped", tone: "warn" }
    : c.promotions_opt_in
      ? { key: "marketing", label: "Marketing: opted in", tone: "ok" }
      : { key: "marketing", label: "Marketing: no opt-in", tone: "off" };
  const clinical: ConsentChip = c.clinical_messaging_consent
    ? { key: "clinical", label: "Clinical messages: consent", tone: "ok" }
    : { key: "clinical", label: "Clinical messages: no consent", tone: "off" };
  return [whatsapp, marketing, clinical];
}

/**
 * Lifecycle stage for the header. One place to swap in the organisation's thresholds once the settings loader lands
 * (pass them as `thresholds`); until then the defaults apply.
 */
export function headerLifecycle(
  input: { unitePin: string | null; firstVisitDate: string | null; lastVisitDate: string | null },
  today: string,
  thresholds: LifecycleThresholds = DEFAULT_LIFECYCLE_THRESHOLDS,
): LifecycleStage {
  return lifecycleStage(input, today, thresholds);
}

function addDays(ymd: string, days: number): string | null {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Is a prescription still running? Needs a start date and a positive duration; otherwise `current` is null (unknown,
 * never guessed). `endsOn` is the last day of the course.
 */
export function medicineWindow(
  startDate: string | null,
  durationDays: number | null,
  today: string,
): { endsOn: string | null; current: boolean | null } {
  if (!startDate || !durationDays || durationDays <= 0) return { endsOn: null, current: null };
  const endsOn = addDays(startDate, durationDays - 1);
  if (!endsOn) return { endsOn: null, current: null };
  return { endsOn, current: startDate <= today && endsOn >= today };
}

/** Cap free text shown on the page (the scrubbed observation note). */
export function capNote(text: string | null, max = 2000): string | null {
  const t = text?.trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
