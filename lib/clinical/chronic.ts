import { Needs, type ClinicalSettings } from "@/lib/clinical/settings";

/**
 * Chronic conditions from visit diagnoses (Phase 21, rule R-20 input).
 *
 * The chronic recall view reads `contact_chronic_conditions`. In the Make/Airtable era that list was the
 * Unite base's patient-level "Chronic Diagnosis" link, filled by Unite. Pulse also derives it from the
 * diagnoses coded on a patient's visits: a diagnosis whose reference row (`ref_diagnoses.chronic`) is
 * flagged chronic, recorded on at least `chronic_condition_min_visits` separate visits, makes it one of the
 * patient's chronic conditions.
 *
 * Pure, no I/O. FAIL CLOSED: an unknown code (no reference row), a blank or false chronic flag, a missing
 * patient or visit date never produces a condition, and while the threshold is not signed off nothing is
 * derived at all. The caller removes previously derived rows that this function no longer returns.
 *
 * Medication classes are NOT used: the audit (docs/audit/clinical-rules.md, R-05) defines no chronic
 * medication class, so a drug never makes a condition chronic.
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
    if (f.chronic === null || f.chronic === undefined) {
      skip("chronic_flag_unknown");
      continue;
    }
    if (f.chronic !== true) {
      skip("not_chronic");
      continue;
    }
    const visits =
      typeof f.visitCount === "number" && Number.isFinite(f.visitCount) ? f.visitCount : 0;
    const first = f.firstVisitDate && YMD.test(f.firstVisitDate) ? f.firstVisitDate : null;
    const last = f.lastVisitDate && YMD.test(f.lastVisitDate) ? f.lastVisitDate : null;
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
