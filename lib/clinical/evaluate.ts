import { ageAtVisit } from "@/lib/clinical/age";
import { triggerCategory, type TriggerCategory } from "@/lib/clinical/category";
import { departmentEffective, mapDepartment, type Department } from "@/lib/clinical/department";
import { dedupeKey, followUpDueDate, type ClinicCalendar } from "@/lib/clinical/followup";
import { scrubNarrative, SCRUB_VERSION } from "@/lib/clinical/negation";
import { ClinicalSettings, Needs } from "@/lib/clinical/settings";
import { txt } from "@/lib/clinical/text";
import { gpRules } from "@/lib/clinical/triggers/gp";
import { gynRules } from "@/lib/clinical/triggers/gyn";
import { paedsRules } from "@/lib/clinical/triggers/paeds";
import type { VisitFacts } from "@/lib/clinical/triggers/facts";
import { vitalsComplete } from "@/lib/clinical/vitals";

export const ENGINE_VERSION = "1";

export type MedClass =
  "antibiotic" | "steroid" | "probiotic" | "supplement" | "enzyme" | "other" | "unclassified";

/** A stored visit, as the engine reads it. Vitals are already parsed (see ingest.ts). */
export type EvalInput = {
  externalId: string;
  /** YYYY-MM-DD */
  visitDate: string;
  dob: string | null;
  departmentRaw: string | null;
  doctorName: string | null;
  tempC: number | null;
  pulse: number | null;
  bpSystolic: number | null;
  bpDiastolic: number | null;
  spo2: number | null;
  primaryDiagnosisText: string | null;
  secondaryDiagnosisCodes: string | null;
  /** Raw composite of complaints + HPI + doctor + nurse notes; scrubbed here. */
  observationNotesRaw: string | null;
  procedureNotes: string | null;
  investigationsOrdered: string | null;
  investigationCount: number | null;
  planOfTreatment: string | null;
  papResult: VisitFacts["papResult"];
  symptomatic: boolean | null;
  /** Class of every prescription on the visit, from the medication reference (unknown = unclassified). */
  prescriptionClasses: readonly MedClass[];
};

export type Evaluation = {
  engineVersion: string;
  scrubVersion: number;
  ageAtVisit: number | null;
  departmentEffective: Department | null;
  vitalsComplete: boolean;
  /** Narrative with negations removed; null when the cue list isn't signed off (narrative rules then stay silent). */
  observationNotesScrubbed: string | null;
  rulesFired: string[];
  triggerCategory: TriggerCategory | null;
  followUpDueDate: string | null;
  dedupeKey: string | null;
  /** Settings that were needed but unsigned. Non-empty = some rules did not run. */
  missingSettings: string[];
  settingsSnapshot: Record<string, string | null>;
};

/**
 * Runs R-06…R-11 for one visit. Pure: same visit + same settings + same calendar = same answer.
 * An unsigned setting never fires a rule; it is reported in `missingSettings` so the portal can
 * say "N visits could not be fully evaluated" instead of staying silently quiet.
 */
export function evaluateVisit(
  input: EvalInput,
  settings: ClinicalSettings,
  calendar: ClinicCalendar,
): Evaluation {
  const need = new Needs(settings);
  const age = ageAtVisit(input.dob, input.visitDate);

  const cues = need.list("negation_cues");
  const scrubbed = cues ? scrubNarrative(input.observationNotesRaw, cues) : null;

  const dept = departmentEffective(
    { ageAtVisit: age, doctorName: input.doctorName, mapped: mapDepartment(input.departmentRaw) },
    settings,
  );
  for (const k of dept.missing) need.missing.add(k);

  const facts: VisitFacts = {
    ageAtVisit: age,
    tempC: input.tempC,
    pulse: input.pulse,
    bpSystolic: input.bpSystolic,
    bpDiastolic: input.bpDiastolic,
    spo2: input.spo2,
    dx: txt(input.primaryDiagnosisText),
    dx2: txt(input.secondaryDiagnosisCodes),
    obs: txt(scrubbed),
    proc: txt(input.procedureNotes),
    inv: txt(input.investigationsOrdered),
    plan: txt(input.planOfTreatment),
    investigationCount: input.investigationCount,
    papResult: input.papResult,
    symptomatic: input.symptomatic,
    hasAntibiotic: input.prescriptionClasses.includes("antibiotic"),
    hasSteroid: input.prescriptionClasses.includes("steroid"),
  };

  let fired: string[] = [];
  switch (dept.department) {
    case "paediatrics":
      fired = paedsRules({ facts, need }).fired;
      break;
    case "gp":
      fired = gpRules({ facts, need }).fired;
      break;
    case "gynaecology":
      fired = gynRules({ facts, need }).fired;
      break;
    default:
      break; // dermatology / other / undetermined: no rule set
  }

  let category: TriggerCategory | null = null;
  let due: string | null = null;
  let key: string | null = null;
  if (fired.length > 0 && dept.department) {
    category = triggerCategory(dept.department, facts, need);
    due = followUpDueDate(input.visitDate, category, input.planOfTreatment, calendar, need);
    key = dedupeKey(input.externalId, category);
  }

  return {
    engineVersion: ENGINE_VERSION,
    scrubVersion: SCRUB_VERSION,
    ageAtVisit: age,
    departmentEffective: dept.department,
    vitalsComplete: vitalsComplete(input),
    observationNotesScrubbed: scrubbed,
    rulesFired: fired,
    triggerCategory: category,
    followUpDueDate: due,
    dedupeKey: key,
    missingSettings: [...need.missing].sort(),
    settingsSnapshot: settings.snapshot([...need.used].sort()),
  };
}

/** Deterministic fingerprint of everything an evaluation read, to skip unchanged visits. */
export function inputsHash(input: EvalInput, snapshot: Record<string, string | null>): string {
  const s = JSON.stringify([input, snapshot]);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${ENGINE_VERSION}:${(h >>> 0).toString(16)}:${s.length}`;
}
