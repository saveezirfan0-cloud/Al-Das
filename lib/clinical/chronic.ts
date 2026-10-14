import { Needs, type ClinicalSettings } from "@/lib/clinical/settings";

/**
 * Chronic conditions (Phase 21, rule R-20 input; aligned with Airtable in 21B).
 *
 * The chronic recall view reads `contact_chronic_conditions`. In the Make/Airtable era that list was the
 * Unite base's patient-level "Chronic Diagnosis" link, which was NOT filled by Unite: the Make scenario
 * "Update Chronic" copied every diagnosis of every new visit into it, with no filter on the Diagnosis
 * "Chronic" flag. Only the chronic-flagged codes ever counted for recall (through their condition group),
 * and one coded visit was enough. So in Pulse a chronic condition is a diagnosis whose reference row
 * (`ref_diagnoses.chronic`) is flagged chronic, from either source:
 *  - the imported list, keeping only chronic-flagged links (`chronicFlagSkip`), and
 *  - derived from the diagnoses coded on a patient's visits, recorded on at least
 *    `chronic_condition_min_visits` separate visits (`deriveChronicConditions`).
 * Recall counts days from the later of the latest Pulse visit and Unite's patient-level last visit date
 * (`effectiveLastVisitDate`); the SQL views apply the same rules.
 *
 * Pure, no I/O. FAIL CLOSED: an unknown code (no reference row), a blank or false chronic flag, a missing
 * patient or visit date never produces a condition, and while the threshold is not signed off nothing is
 * derived at all. The caller removes previously derived rows that this function no longer returns.
 *
 * Medication classes are NOT used: the audit (docs/audit/clinical-rules.md, R-05) defines no chronic
 * medication class, so a drug never makes a condition chronic. (Airtable's "60 days >" long-prescription
 * flag is an open decision, OQ-104 (4).)
 */

/** One patient + diagnosis, aggregated over that patient's non-test visits. */
export type ChronicDiagnosisFact = {
  contactId: string | null;
  refDiagnosisId: string | null;
  /** ref_diagnoses.chronic; null when the reference row could not be read. */
  chronic: boolean | null;
  /** Distinct visits with this diagnosis. */
  visitCount: number | null;
  /** YYYY-MM-DD */
  firstVisitDate: string | null;
  lastVisitDate: string | null;
};

export type DerivedChronicCondition = {
  contactId: string;
  refDiagnosisId: string;
  /** First visit that recorded the diagnosis. */
  notedAt: string;
  lastSeenOn: string;
  evidenceVisits: number;
};

export type ChronicSkipReason =
  | "no_patient"
  | "unknown_code"
  | "not_chronic"
  | "chronic_flag_unknown"
  | "no_visit_date"
  | "below_min_visits";

export type ChronicDerivation = {
  conditions: DerivedChronicCondition[];
  /** Settings the rule needed but could not use (nothing is derived while this is not empty). */
  missingSettings: string[];
  skipped: Partial<Record<ChronicSkipReason, number>>;
};

export const CHRONIC_MIN_VISITS_KEY = "chronic_condition_min_visits";

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const blank = (s: string | null | undefined) => !s || s.trim() === "";

/** A real calendar date written YYYY-MM-DD (2026-02-30 is not). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Does this diagnosis count as chronic? Only a flag that is exactly true does (a blank flag is not
 * chronic: fail closed). Used for both sources: the imported patient-level Chronic Diagnosis list held
 * every visit diagnosis (Make "Update Chronic"), so its links are filtered with this too. Returns null
 * when the diagnosis counts, otherwise why it does not.
 */
export function chronicFlagSkip(
  chronic: boolean | null | undefined,
): Extract<ChronicSkipReason, "not_chronic" | "chronic_flag_unknown"> | null {
  if (chronic === true) return null;
  return chronic === false ? "not_chronic" : "chronic_flag_unknown";
}

/**
 * The last-visit date chronic recall counts from: the later of the latest Pulse visit and Unite's
 * patient-level Last Visit Date (Airtable's "Time Elapsed" used the Unite date, which also covers
 * patients with no visit in Pulse). A value that is not a real date is ignored; neither → null (the
 * patient is never eligible).
 */
export function effectiveLastVisitDate(
  pulseLastVisit: string | null | undefined,
  uniteLastVisit: string | null | undefined,
): string | null {
  const dates = [pulseLastVisit, uniteLastVisit].filter(isCalendarDate);
  if (dates.length === 0) return null;
  return dates.reduce((a, b) => (b > a ? b : a));
}

/** The signed-off minimum, or undefined (missing, unsigned, not a whole number of at least 1). */
export function chronicMinVisits(settings: ClinicalSettings): number | undefined {
  const n = new Needs(settings).num(CHRONIC_MIN_VISITS_KEY);
  return n !== undefined && Number.isInteger(n) && n >= 1 ? n : undefined;
}

export function deriveChronicConditions(
  facts: readonly ChronicDiagnosisFact[],
  settings: ClinicalSettings,
): ChronicDerivation {
  const skipped: ChronicDerivation["skipped"] = {};
  const skip = (r: ChronicSkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1);
  const min = chronicMinVisits(settings);
  if (min === undefined)
    return { conditions: [], missingSettings: [CHRONIC_MIN_VISITS_KEY], skipped };

  // Merge duplicates of the same patient + diagnosis (the SQL already aggregates; this keeps the rule honest).
  const merged = new Map<string, DerivedChronicCondition>();
  for (const f of facts) {
    if (blank(f.contactId)) {
      skip("no_patient");
      continue;
    }
    if (blank(f.refDiagnosisId)) {
      skip("unknown_code");
      continue;
    }
    const flag = chronicFlagSkip(f.chronic);
    if (flag) {
      skip(flag);
      continue;
    }
    const visits =
      typeof f.visitCount === "number" && Number.isFinite(f.visitCount) ? f.visitCount : 0;
    const first = isCalendarDate(f.firstVisitDate) ? f.firstVisitDate : null;
    const last = isCalendarDate(f.lastVisitDate) ? f.lastVisitDate : null;
    if (visits <= 0 || !first || !last) {
      skip("no_visit_date");
      continue;
    }
    const key = `${f.contactId}|${f.refDiagnosisId}`;
    const prev = merged.get(key);
    merged.set(key, {
      contactId: f.contactId as string,
      refDiagnosisId: f.refDiagnosisId as string,
      notedAt: prev && prev.notedAt < first ? prev.notedAt : first,
      lastSeenOn: prev && prev.lastSeenOn > last ? prev.lastSeenOn : last,
      evidenceVisits: (prev?.evidenceVisits ?? 0) + visits,
    });
  }

  const conditions: DerivedChronicCondition[] = [];
  for (const c of merged.values()) {
    if (c.evidenceVisits < min) skip("below_min_visits");
    else conditions.push(c);
  }
  conditions.sort((a, b) =>
    a.contactId === b.contactId
      ? a.refDiagnosisId.localeCompare(b.refDiagnosisId)
      : a.contactId.localeCompare(b.contactId),
  );
  return { conditions, missingSettings: [], skipped };
}

/** The JSON rows public.clinical_apply_chronic_conditions() takes. */
export function toApplyRows(conditions: readonly DerivedChronicCondition[]) {
  return conditions.map((c) => ({
    contact_id: c.contactId,
    ref_diagnosis_id: c.refDiagnosisId,
    noted_at: c.notedAt,
    last_seen_on: c.lastSeenOn,
    evidence_visits: c.evidenceVisits,
  }));
}
