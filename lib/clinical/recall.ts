/**
 * Recall programmes (R-20…R-25): who is recalled, with which template, and when a recall that got
 * no reply moves to the care coordinator's call list. Pure functions: the engine
 * (lib/recall/engine.ts) loads facts and persists the outcome.
 *
 * FAIL CLOSED: a threshold that is not signed off (undefined), a segment with no mapped template,
 * a date that does not parse, a send mode that is not exactly "live" → nothing is sent.
 */
import { workdaysBetween, type ClinicCalendar } from "@/lib/clinical/followup";

export type SendMode = "test" | "live";

/** Only the exact word "live" opens live sending; anything else (blank, typo, null) is test. */
export function resolveSendMode(
  override: string | null | undefined,
  setting: string | null | undefined,
): SendMode {
  const v = (override ?? setting ?? "").trim().toLowerCase();
  return v === "live" ? "live" : "test";
}

// ---------------------------------------------------------------------------
// R-20 / R-21: condition groups
// ---------------------------------------------------------------------------

export type ChronicGroup = { key: string; sort: number; messageable: boolean };

/** Messageable groups only (mental-health groups are removed, OQ-25), de-duplicated, in priority order. */
export function chronicGroupKeys(groups: readonly ChronicGroup[]): string[] {
  const seen = new Set<string>();
  return [...groups]
    .filter((g) => g.messageable)
    .sort((a, b) => a.sort - b.sort || a.key.localeCompare(b.key))
    .map((g) => g.key)
    .filter((k) => (seen.has(k) ? false : (seen.add(k), true)));
}

/** R-21: the first messageable group by priority; null = nothing to recall for. */
export function primaryChronicGroup(groups: readonly ChronicGroup[]): string | null {
  return chronicGroupKeys(groups)[0] ?? null;
}

export function parseGroups(raw: unknown): ChronicGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: ChronicGroup[] = [];
  for (const g of raw) {
    const o = g as Record<string, unknown> | null;
    if (!o || typeof o.key !== "string" || !o.key) continue;
    out.push({
      key: o.key,
      sort: typeof o.sort === "number" ? o.sort : 100,
      messageable: o.messageable === true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// R-23: template per segment
// ---------------------------------------------------------------------------

export type RecallTemplateRow = {
  id: string;
  segmentKey: string;
  waTemplateId: string | null;
  active: boolean;
};

/** A mapped, active row for the segment. No implicit default: an unmapped segment sends nothing (OQ-24). */
export function templateForSegment(
  rows: readonly RecallTemplateRow[],
  segment: string,
): RecallTemplateRow | null {
  const row = rows.find((r) => r.segmentKey === segment);
  return row && row.active && row.waTemplateId ? row : null;
}

// ---------------------------------------------------------------------------
// Birthdays (OQ-17, OQ-18)
// ---------------------------------------------------------------------------

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const pad = (n: number) => String(n).padStart(2, "0");

function parts(date: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
    ? [y, mo, d]
    : null;
}

/** Whole years between a date of birth and `today` (YYYY-MM-DD); NaN when either does not parse. */
export function ageOn(dob: string, today: string): number {
  const b = parts(dob);
  const t = parts(today);
  if (!b || !t) return Number.NaN;
  let age = t[0] - b[0];
  if (t[1] < b[1] || (t[1] === b[1] && t[2] < b[2])) age--;
  return age;
}

/** The 'MM-DD' values whose birthday is "today": 29 February people are greeted on 1 March in non-leap years. */
export function birthdayMonthDays(today: string): string[] {
  const t = parts(today);
  if (!t) return [];
  const out = [`${pad(t[1])}-${pad(t[2])}`];
  if (t[1] === 3 && t[2] === 1 && !isLeap(t[0])) out.push("02-29");
  return out;
}

export type BirthdayBand = {
  key: string;
  gender: "male" | "female";
  min_age?: number;
  max_age?: number;
};

export function parseBands(config: unknown): BirthdayBand[] {
  const raw = (config as { bands?: unknown } | null)?.bands;
  if (!Array.isArray(raw)) return [];
  const out: BirthdayBand[] = [];
  for (const b of raw) {
    const o = b as Record<string, unknown> | null;
    if (!o || typeof o.key !== "string" || (o.gender !== "male" && o.gender !== "female")) continue;
    out.push({
      key: o.key,
      gender: o.gender,
      min_age: typeof o.min_age === "number" ? o.min_age : undefined,
      max_age: typeof o.max_age === "number" ? o.max_age : undefined,
    });
  }
  return out;
}

/** The first band that fits; uncovered ages and genders get nothing (they are counted, not guessed). */
export function birthdayBand(
  bands: readonly BirthdayBand[],
  gender: string | null | undefined,
  age: number,
): string | null {
  if (!Number.isFinite(age) || (gender !== "male" && gender !== "female")) return null;
  return (
    bands.find(
      (b) =>
        b.gender === gender &&
        (b.min_age === undefined || age >= b.min_age) &&
        (b.max_age === undefined || age <= b.max_age),
    )?.key ?? null
  );
}

// ---------------------------------------------------------------------------
// "Time since the last visit" programmes
// ---------------------------------------------------------------------------

export type VisitGapRule = {
  minDays: number | null;
  maxDays: number | null;
  gender: "male" | "female" | null;
  minAge: number | null;
  maxAge: number | null;
};

const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;

export function parseVisitGapRule(config: unknown): VisitGapRule {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    minDays: posInt(c.min_days),
    maxDays: posInt(c.max_days),
    gender: c.gender === "male" || c.gender === "female" ? c.gender : null,
    minAge: posInt(c.min_age),
    maxAge: posInt(c.max_age),
  };
}

// ---------------------------------------------------------------------------
// May this recall be sent? (R-26 for clinical programmes)
// ---------------------------------------------------------------------------

export type SkipReason =
  | "no_segment"
  | "no_template"
  | "template_not_approved"
  | "template_not_clinically_approved"
  | "clinical_gate_closed"
  | "no_opt_in"
  | "band_not_covered";

export function decideRecallSend(i: {
  kind: string;
  gateOpen: boolean;
  templateMetaStatus: string | null | undefined;
  templateClinicalApproval: string | null | undefined;
}): { allow: true } | { allow: false; reason: SkipReason } {
  if (i.templateMetaStatus !== "APPROVED") return { allow: false, reason: "template_not_approved" };
  if (i.kind === "chronic") {
    if (!i.gateOpen) return { allow: false, reason: "clinical_gate_closed" };
    if (i.templateClinicalApproval !== "approved")
      return { allow: false, reason: "template_not_clinically_approved" };
  }
  return { allow: true };
}

// ---------------------------------------------------------------------------
// R-24 / R-25: call list and overdue flag
// ---------------------------------------------------------------------------

export type SendFacts = {
  sendMode: string;
  status: string;
  /** YYYY-MM-DD in the clinic's time zone. */
  sentDate: string | null;
  repliedAt: string | null;
  followUpStatus: string | null;
  daysSinceLastVisitAtSend: number | null;
};

export function followUpState(
  s: SendFacts,
  today: string,
  calendar: ClinicCalendar,
  settings: { followupWorkdays?: number; overdueDays?: number },
): { callNow: boolean; overdue: boolean | null; workdaysWaiting: number | null } {
  const waiting = s.sentDate ? workdaysBetween(s.sentDate, today, calendar) : null;
  const open =
    s.sendMode === "live" &&
    ["sent", "delivered", "read"].includes(s.status) &&
    !s.repliedAt &&
    s.followUpStatus !== "booked";
  const callNow =
    open &&
    settings.followupWorkdays !== undefined &&
    waiting !== null &&
    waiting >= settings.followupWorkdays;
  const overdue =
    settings.overdueDays !== undefined && s.daysSinceLastVisitAtSend !== null
      ? s.daysSinceLastVisitAtSend > settings.overdueDays
      : null;
  return { callNow, overdue, workdaysWaiting: waiting };
}

// ---------------------------------------------------------------------------
// Attribution of replies and bookings (replaces Make's phone-only "Chronic Update" match, OQ-22)
// ---------------------------------------------------------------------------

export type OpenSend = {
  id: string;
  sentAt: string | null;
  repliedAt: string | null;
  bookedAt: string | null;
};

const DAY = 86_400_000;

function withinWindow(sentAt: string | null, at: Date, days: number | undefined): boolean {
  if (days === undefined || !sentAt) return false; // fail closed: unsigned window attributes nothing
  const t = new Date(sentAt).getTime();
  const age = at.getTime() - t;
  return Number.isFinite(t) && age >= 0 && age <= days * DAY;
}

/** The latest recall that has not been answered yet and was sent inside the window. */
export function pickSendForReply(
  sends: readonly OpenSend[],
  at: Date,
  days: number | undefined,
): OpenSend | null {
  return (
    sends
      .filter((s) => !s.repliedAt && withinWindow(s.sentAt, at, days))
      .sort((a, b) => new Date(b.sentAt!).getTime() - new Date(a.sentAt!).getTime())[0] ?? null
  );
}

/** The latest recall (answered or not) that has not produced a booking yet and was sent inside the window. */
export function pickSendForBooking(
  sends: readonly OpenSend[],
  at: Date,
  days: number | undefined,
): OpenSend | null {
  return (
    sends
      .filter((s) => !s.bookedAt && withinWindow(s.sentAt, at, days))
      .sort((a, b) => new Date(b.sentAt!).getTime() - new Date(a.sentAt!).getTime())[0] ?? null
  );
}
