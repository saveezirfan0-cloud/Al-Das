/**
 * Parallel-run comparison: native output vs what Make produced for the same day.
 * Only salted hashes of Unite PINs / appointment ids are ever compared or stored (no names, phones, messages).
 */
import { createHash } from "node:crypto";

export const SCENARIO_KEYS = [
  "token",
  "appointment_reminders",
  "birthday",
  "chronic_recall",
  "chronic_update",
  "mrd_sync",
  "airtable_automations",
] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

/** Scenarios whose daily output is a set of ids we can compare today. The rest are blocked on Phase 6 (see docs/06). */
export const COMPARABLE: ReadonlySet<ScenarioKey> = new Set<ScenarioKey>([
  "appointment_reminders",
  "birthday",
  "chronic_recall",
  "chronic_update",
]);

export function hashRef(orgId: string, id: string): string {
  return createHash("sha256").update(`${orgId}:${id.trim()}`).digest("hex");
}

export type SetDiff = {
  make_count: number;
  native_count: number;
  only_in_make: string[];
  only_in_native: string[];
};

export function diffSets(make: Iterable<string>, native: Iterable<string>): SetDiff {
  const m = new Set(make);
  const n = new Set(native);
  return {
    make_count: m.size,
    native_count: n.size,
    only_in_make: [...m].filter((x) => !n.has(x)).sort(),
    only_in_native: [...n].filter((x) => !m.has(x)).sort(),
  };
}

export function isIdentical(d: SetDiff): boolean {
  return d.only_in_make.length === 0 && d.only_in_native.length === 0;
}

export type DayDiff = SetDiff & { run_date: string; explained: boolean };

/** A scenario may be retired when: native built, ≥7 compared days, every day with a difference explained, and the latest 7 days all recorded. */
export function retirementReadiness(input: {
  native_built: boolean;
  days: DayDiff[];
  required_days?: number;
}): { ready: boolean; reasons: string[] } {
  const need = input.required_days ?? 7;
  const reasons: string[] = [];
  if (!input.native_built) reasons.push("Native replacement is not built yet");
  if (input.days.length < need)
    reasons.push(`Only ${input.days.length} of ${need} parallel days compared`);
  const unexplained = input.days.filter((d) => !isIdentical(d) && !d.explained);
  if (unexplained.length) reasons.push(`${unexplained.length} day(s) with unexplained differences`);
  return { ready: reasons.length === 0, reasons };
}

/** Yesterday (the last complete day) as YYYY-MM-DD in the clinic timezone. */
export function previousDay(now: Date, timezone = "Asia/Dubai"): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now);
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Rows for parallel_run_make_outputs from a list of raw Unite PINs / appointment ids (hashed here; ids are never stored). */
export function makeOutputRows(orgId: string, scenario: ScenarioKey, day: string, ids: string[]) {
  return [...new Set(ids.map((i) => i.trim()).filter(Boolean))].map((id) => ({
    org_id: orgId,
    scenario_key: scenario,
    run_date: day,
    ref_hash: hashRef(orgId, id),
  }));
}
