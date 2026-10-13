/**
 * Recurring campaigns (Phase 20d, pure; unit-tested): the readable summary of a 5-field cron, the next run time in a
 * timezone, the "at most once a day" rule, and the checks every run repeats before it creates its campaign.
 * The cron grammar is lib/cron.ts (also used by recurring flows and recall).
 */
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

import { parseCron } from "@/lib/cron";

type Fields = NonNullable<ReturnType<typeof parseCron>>;
type Field = Fields[number];

/** A recurring campaign may not run more often than this (patients would get the same broadcast twice a day). */
export const MIN_RECURRENCE_GAP_HOURS = 24;
/** How far ahead nextCronRun looks before giving up (covers yearly schedules like "1 Jan"). */
const LOOKAHEAD_DAYS = 400;

export const RECURRENCE_PRESETS: ReadonlyArray<{ key: string; label: string; cron: string }> = [
  { key: "daily", label: "Every day at 10:00", cron: "0 10 * * *" },
  { key: "weekdays", label: "Monday to Friday at 10:00", cron: "0 10 * * 1-5" },
  { key: "weekly", label: "Every Monday at 10:00", cron: "0 10 * * 1" },
  { key: "monthly", label: "On the 1st of every month at 10:00", cron: "0 10 1 * *" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
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
];

const sorted = (f: Field) => [...f.values].sort((a, b) => a - b);
const pad = (n: number) => String(n).padStart(2, "0");

function list(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

/** Day-of-week values with 7 folded onto 0 (both mean Sunday). */
function weekdays(f: Field): number[] {
  return [...new Set(sorted(f).map((d) => d % 7))].sort((a, b) => a - b);
}

function weekdayPhrase(days: number[]): string {
  const key = days.join(",");
  if (key === "1,2,3,4,5") return "Monday to Friday";
  if (key === "0,1,2,3,4") return "Sunday to Thursday";
  if (key === "0,6") return "Saturday and Sunday";
  return list(days.map((d) => DAY_NAMES[d]!));
}

/**
 * A plain-language summary ("Every Monday at 10:00", "On the 1st of every month at 09:30 and 17:30") or null when the
 * expression is invalid. Times are local to the schedule's timezone, which the caller shows next to it.
 */
export function describeCron(expr: string): string | null {
  const f = parseCron(expr);
  if (!f) return null;
  const [minute, hour, dom, month, dow] = f as [Field, Field, Field, Field, Field];

  let time: string;
  if (minute.star && hour.star) time = "every minute";
  else if (hour.star) time = `every hour at ${list(sorted(minute).map((m) => `:${pad(m)}`))}`;
  else if (minute.star) time = `every minute from ${list(sorted(hour).map((h) => `${pad(h)}:00`))}`;
  else {
    const times: string[] = [];
    for (const h of sorted(hour)) for (const m of sorted(minute)) times.push(`${pad(h)}:${pad(m)}`);
    time = times.length > 6 ? `${times.length} times a day` : `at ${list(times)}`;
  }

  let days: string;
  if (dom.star && dow.star) days = "Every day";
  else if (dom.star) days = `Every ${weekdayPhrase(weekdays(dow))}`;
  else if (dow.star) days = `On the ${list(sorted(dom).map(ordinal))}`;
  else days = `On the ${list(sorted(dom).map(ordinal))} or every ${weekdayPhrase(weekdays(dow))}`;

  let months = "";
  if (!month.star) months = ` in ${list(sorted(month).map((m) => MONTH_NAMES[m - 1]!))}`;
  else if (!dom.star) months = " of every month";

  return `${days}${months} ${time}`.replace(/\s+/g, " ").trim();
}

function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayMatches(fields: Fields, ymd: string): boolean {
  const [, , dom, month, dow] = fields as [Field, Field, Field, Field, Field];
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  if (!month.values.has(m)) return false;
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const domOk = dom.values.has(d);
  const dowOk = dow.values.has(wd) || (wd === 0 && dow.values.has(7));
  if (dom.star && dow.star) return true;
  if (dom.star) return dowOk;
  if (dow.star) return domOk;
  return domOk || dowOk; // Vixie cron: either restricted field may match
}

/** The first time strictly after `after` at which `expr` fires in `timezone`, or null (invalid, or none within ~13 months). */
export function nextCronRun(expr: string, after: Date, timezone: string): Date | null {
  const f = parseCron(expr);
  if (!f) return null;
  const [minute, hour] = f as [Field, Field];
  const hours = sorted(hour);
  const minutes = sorted(minute);
  const start = formatInTimeZone(after, timezone, "yyyy-MM-dd");
  for (let i = 0; i <= LOOKAHEAD_DAYS; i++) {
    const ymd = addDaysYmd(start, i);
    if (!dayMatches(f, ymd)) continue;
    for (const h of hours)
      for (const m of minutes) {
        const at = fromZonedTime(`${ymd}T${pad(h)}:${pad(m)}:00`, timezone);
        // A local time that does not exist (DST spring-forward) maps to a later instant; it must still read as h:m.
        if (formatInTimeZone(at, timezone, "yyyy-MM-dd HH:mm") !== `${ymd} ${pad(h)}:${pad(m)}`)
          continue;
        if (at.getTime() > after.getTime()) return at;
      }
  }
  return null;
}

/** The next `count` run times (for the form preview and the gap check). */
export function upcomingRuns(expr: string, after: Date, timezone: string, count = 3): Date[] {
  const out: Date[] = [];
  let cursor = after;
  while (out.length < count) {
    const next = nextCronRun(expr, cursor, timezone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Why a schedule cannot be used for a recurring campaign, or null when it can. */
export function checkRecurrenceSchedule(expr: string, timezone: string, now: Date): string | null {
  if (!parseCron(expr)) return "That schedule is not a valid 5-part cron expression.";
  if (!isValidTimezone(timezone)) return "Choose a valid timezone.";
  const runs = upcomingRuns(expr, now, timezone, 8);
  if (runs.length === 0) return "That schedule never runs in the next year.";
  for (let i = 1; i < runs.length; i++)
    if (runs[i]!.getTime() - runs[i - 1]!.getTime() < MIN_RECURRENCE_GAP_HOURS * 3600_000)
      return "A recurring campaign can run at most once a day.";
  return null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz.length > 0;
  } catch {
    return false;
  }
}

export type RecurrenceSkipReason =
  | "channel_inactive"
  | "template_missing"
  | "template_not_approved"
  | "template_archived"
  | "waba_mismatch"
  | "segment_missing"
  | "quality_red"
  | "media_unusable"
  | "previous_run_active"
  | "budget_reached";

export const SKIP_REASON_LABEL: Record<RecurrenceSkipReason, string> = {
  channel_inactive: "the WhatsApp number is paused or disconnected",
  template_missing: "the template no longer exists",
  template_not_approved: "the template is not approved",
  template_archived: "the template is archived",
  waba_mismatch: "the template belongs to another WhatsApp account",
  segment_missing: "the segment was deleted",
  quality_red: "the number's quality rating is low (red)",
  media_unusable: "a Media Library file in the mapping can no longer be used",
  previous_run_active: "the previous run is still sending",
  budget_reached: "the monthly message budget is used up",
};

/**
 * The guardrails every run re-checks before it creates its campaign (nothing is sent for a skipped run; the next one
 * is still scheduled). The campaign itself then runs through the normal engine guardrails and consent checks.
 */
export function recurrenceRunDecision(input: {
  channel: { status: string; waba_id: string; quality_rating: string | null } | null;
  template: { status: string; archived_at: string | null; waba_id: string } | null;
  segmentExists: boolean;
  mediaProblem: string | null;
  previousRunActive: boolean;
  budget: { used: number; monthly_limit: number | null } | null;
}): { run: true } | { run: false; reason: RecurrenceSkipReason } {
  const no = (reason: RecurrenceSkipReason) => ({ run: false as const, reason });
  if (!input.channel || input.channel.status !== "active") return no("channel_inactive");
  if (!input.template) return no("template_missing");
  if (input.template.archived_at) return no("template_archived");
  if (input.template.status !== "APPROVED") return no("template_not_approved");
  if (input.template.waba_id !== input.channel.waba_id) return no("waba_mismatch");
  if (!input.segmentExists) return no("segment_missing");
  if ((input.channel.quality_rating ?? "").toUpperCase() === "RED") return no("quality_red");
  if (input.mediaProblem) return no("media_unusable");
  if (input.previousRunActive) return no("previous_run_active");
  if (
    input.budget &&
    input.budget.monthly_limit !== null &&
    input.budget.used >= input.budget.monthly_limit
  )
    return no("budget_reached");
  return { run: true };
}
