/**
 * Test fixtures for the clinical rules: SYNTHETIC data only (no names, phones or real notes).
 * Defaults are the PROPOSED values seeded in clinical_settings, signed off for the test, plus the
 * two blocking settings (day-3 HALT threshold, side-effect keywords) injected as TP-04 / TP-16 require.
 */
import type { EvalInput } from "@/lib/clinical/evaluate";
import type { ClinicCalendar } from "@/lib/clinical/followup";
import { ClinicalSettings, type SettingRow } from "@/lib/clinical/settings";

export const DEFAULT_VALUES: Record<string, string | number | boolean | string[]> = {
  paeds_age_cutoff_years: 14,
  infant_age_cutoff_years: 2,
  paeds_fever_temp_c: 39.0,
  infant_fever_temp_c: 38.0,
  spo2_low_pct: 94,
  adult_fever_temp_c: 39.0,
  adult_bp_systolic_low: 90,
  adult_bp_diastolic_low: 60,
  adult_pulse_high: 110,
  gyn_bp_systolic_low: 95,
  gyn_pulse_high: 100,
  day3_offset_days: 2,
  probiotic_default_days: 10,
  red_flag_score_threshold: 5,
  day3_halt_threshold: 4, // BLOCKING in production: injected for the tests
  side_effect_keywords: [
    "rash",
    "swelling",
    "vomiting",
    "diarrhoea",
    "dizziness",
    "breathing difficulty",
    "allergic reaction",
  ],
  doctor_routing_gynaecology: [],
  doctor_routing_paediatrics: [],
  doctor_routing_gp: [],
  negation_cues: [
    "no",
    "not",
    "denies",
    "denied",
    "deny",
    "negative for",
    "without",
    "nil",
    "absent",
    "-ve",
    "no evidence of",
    "rules out",
    "ruled out",
    "free of",
  ],
  gp02_redflag_terms: [
    "chest pain",
    "shortness of breath",
    "syncope",
    "fainting",
    "palpitations",
    "severe abdominal pain",
    "persistent vomiting",
    "blood in stool",
    "severe headache",
    "neurological deficit",
    "confusion",
  ],
  paed05_respiratory_terms: [
    "shortness of breath",
    "wheeze",
    "bronchiolitis",
    "pneumonia",
    "croup",
    "respiratory distress",
  ],
  paed06_gi_terms: ["vomit", "diarrh"],
  paed06_dehydration_terms: ["poor intake", "dehydrat", "dry mouth", "reduced urine", "lethargic"],
  paed07_infection_terms: [
    "uti",
    "pyelonephritis",
    "tonsillitis",
    "otitis media",
    "pneumonia",
    "cellulitis",
  ],
  paed09_plan_terms: [
    "er advised",
    "ed advised",
    "return if worse",
    "follow up advised",
    "follow-up advised",
  ],
  gp03_infection_terms: ["infect", "pneumonia", "uti", "cellulitis", "abscess", "infected wound"],
  gp06_plan_terms: ["follow up advised", "follow-up advised", "review in", "return tomorrow"],
  gyn01_bleed_terms: [
    "abnormal uterine bleeding",
    "aub",
    "postcoital",
    "intermenstrual",
    "menorrhagia",
  ],
  gyn02_bleed_terms: ["contact bleeding", "active bleeding"],
  gyn04_obs_terms: ["green discharge", "yellow discharge", "foul"],
  gyn04_investigation_terms: ["hvs", "vaginal swab", "culture"],
  gyn04_diagnosis_terms: ["vaginitis", "cervicitis", "pid", "pelvic inflammatory"],
  gyn05_pain_terms: ["pelvic pain", "perineal pain", "dysmenorrh"],
  gyn05_structural_terms: ["adenomyosis", "fibroid", "endometriosis"],
  gyn05_symptom_terms: ["pain", "bleed", "heavy", "discomfort"],
  gyn07_proc_terms: ["biopsy", "cervical examination"],
  gyn09_plan_terms: ["follow up advised", "review after results", "monitor symptoms"],
  category_bleeding_terms: ["bleed", "menorrhagia", "spotting", "haemorrhage", "hemorrhage"],
  category_infection_terms: [
    "infect",
    "pneumonia",
    "uti",
    "cellulitis",
    "abscess",
    "vaginitis",
    "cervicitis",
    "pid",
  ],
  followup_days_urgent: 1,
  followup_days_standard: 2,
  followup_review_cap_days: 30,
};

const asText = (v: string | number | boolean | string[]) =>
  Array.isArray(v) ? JSON.stringify(v) : String(v);

/** Every given value signed off. */
export function signedSettings(
  overrides: Record<string, string | number | boolean | string[] | null> = {},
): ClinicalSettings {
  const merged = { ...DEFAULT_VALUES, ...overrides };
  const rows: SettingRow[] = [];
  for (const [key, v] of Object.entries(merged)) {
    if (v === null) continue; // removed entirely
    rows.push({
      key,
      approved_value: asText(v),
      proposed_value: asText(v),
      sign_off_status: "approved",
    });
  }
  return new ClinicalSettings(rows);
}

/** Like signedSettings, but the listed keys are only PROPOSED (awaiting sign-off). */
export function settingsWithUnsigned(
  unsigned: string[],
  extra: SettingRow[] = [],
): ClinicalSettings {
  const rows: SettingRow[] = [];
  for (const [key, v] of Object.entries(DEFAULT_VALUES)) {
    rows.push(
      unsigned.includes(key)
        ? { key, approved_value: null, proposed_value: asText(v), sign_off_status: "awaiting" }
        : {
            key,
            approved_value: asText(v),
            proposed_value: asText(v),
            sign_off_status: "approved",
          },
    );
  }
  return new ClinicalSettings([...rows, ...extra]);
}

export const MON_SAT: ClinicCalendar = { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: [] };
export const MON_FRI: ClinicCalendar = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };

/** A blank visit on 2026-03-10 (a Tuesday) for an adult GP patient. */
export function visit(over: Partial<EvalInput> = {}): EvalInput {
  return {
    externalId: "V-1",
    visitDate: "2026-03-10",
    dob: "1985-06-15",
    departmentRaw: "General Practice",
    doctorName: "Dr Example",
    tempC: null,
    pulse: null,
    bpSystolic: null,
    bpDiastolic: null,
    spo2: null,
    primaryDiagnosisText: "",
    secondaryDiagnosisCodes: "",
    observationNotesRaw: "",
    procedureNotes: "",
    investigationsOrdered: "",
    investigationCount: 0,
    planOfTreatment: "",
    papResult: null,
    symptomatic: null,
    prescriptionClasses: [],
    ...over,
  };
}

export const paeds = (over: Partial<EvalInput> = {}) =>
  visit({ departmentRaw: "Paediatrics", dob: "2018-01-01", ...over });
export const gyn = (over: Partial<EvalInput> = {}) =>
  visit({ departmentRaw: "Gynaecology", dob: "1990-01-01", ...over });
