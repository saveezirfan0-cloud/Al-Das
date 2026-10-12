/**
 * Airtable → the Phase 6 clinical tables (visits, prescriptions, follow-ups, feedback, message log,
 * call scripts) and Doctors → specialists. Column names, enums and constraints here match
 * supabase/migrations/20261009000950_clinical_core.sql; tests/db/airtable-import.test.ts checks
 * every mapped column against the live schema so a drift fails CI instead of failing rows.
 *
 * Safety rules (see docs/06_PHASE_9_NOTES.md):
 *  - Imported visits carry `source = 'airtable'`; the clinical engine only evaluates 'unite' visits,
 *    so history never re-raises follow-ups.
 *  - Rows staff work in Pulse (follow-ups, feedback, message log, prescriptions) are createOnly:
 *    a re-import never overwrites their work with the frozen Airtable copy.
 *  - Medication class comes from ref_medication_classes by CODE (R-05), never from Airtable text;
 *    unknown stays 'unclassified' (fails closed).
 *  - An Airtable "approved" is never imported (call scripts stay awaiting until approved in Pulse).
 *  - Nothing here notifies anyone or schedules a send. Message-log rows are terminal history.
 */
import type { TriggerCategory } from "@/lib/clinical/category";
import { dedupeKey } from "@/lib/clinical/followup";
import { PLAUSIBLE, parseBp, parseVital } from "@/lib/clinical/vitals";

import { slug, toBool, toDate, toDateTime, toInt, toNumber, toText } from "../convert";
import { BASE } from "./bases";
import type { TableMapper } from "./types";

const PATIENTS = "unite.patients";
const ACUTE_PATIENTS = "acute.patients";
const EPOCH = "1970-01-01T00:00:00.000Z";

const TRIGGER_CATEGORIES: readonly TriggerCategory[] = [
  "paediatric_high_concern",
  "bleeding",
  "vitals",
  "infection_labs",
  "post_procedure",
  "clinical_check",
];

// ---------------------------------------------------------------------------
// Tolerant select → enum mappers. The schema export has no choice labels, so these match by
// meaning; anything unrecognised becomes null and a warning code (never a guess).
// ---------------------------------------------------------------------------

export function mapTriggerCategory(v: unknown, warn: (c: string) => void): TriggerCategory | null {
  const s = slug(v);
  if (!s) return null;
  const hit = TRIGGER_CATEGORIES.find((c) => c === s);
  if (hit) return hit;
  warn("unknown_trigger_category");
  return null;
}

export function mapPriority(v: unknown, warn: (c: string) => void): "high" | "medium" | null {
  const s = slug(v);
  if (!s) return null;
  if (s === "high" || s === "medium") return s;
  warn("unknown_priority");
  return null;
}

export function mapCallStatus(
  v: unknown,
  warn: (c: string) => void,
): "pending" | "completed" | "escalated" | "no_answer" | null {
  const s = slug(v);
  if (!s) return null;
  if (/^(pending|open|to_do|todo|new)$/.test(s)) return "pending";
  if (/^(completed?|done|closed)$/.test(s)) return "completed";
  if (/escalat/.test(s)) return "escalated";
  if (/no_?answer|not_reached|unreach/.test(s)) return "no_answer";
  warn("unknown_call_status");
  return null;
}

export function mapOutcome(
  v: unknown,
  warn: (c: string) => void,
): "improving" | "same" | "worse" | null {
  const s = slug(v);
  if (!s) return null;
  if (s === "improving" || s === "improved" || s === "better") return "improving";
  if (s === "same" || s === "no_change" || s === "unchanged") return "same";
  if (s === "worse" || s === "worsening" || s === "worsened") return "worse";
  warn("unknown_outcome");
  return null;
}

export function mapFeedbackStage(
  v: unknown,
  warn: (c: string) => void,
): "day3_antibiotics" | "after_antibiotics" | "after_probiotics" | "post_procedure" | null {
  const s = toText(v).toLowerCase();
  if (!s) return null;
  if (/probiotic/.test(s)) return "after_probiotics";
  if (/procedure/.test(s)) return "post_procedure";
  if (/day\s*-?\s*3|during/.test(s)) return "day3_antibiotics";
  if (/after.*antibiotic|antibiotic.*(end|complete)/.test(s)) return "after_antibiotics";
  warn("unknown_feedback_stage");
  return null;
}

function mapDepartmentEnum(
  v: unknown,
  warn: (c: string) => void,
): "paediatrics" | "gp" | "gynaecology" | "dermatology" | "other" | null {
  const s = slug(v);
  if (!s) return null;
  if (s === "paediatrics" || s === "pediatrics") return "paediatrics";
  if (s === "gp" || s === "general_practice") return "gp";
  if (s === "gynaecology" || s === "gynecology") return "gynaecology";
  if (s === "dermatology") return "dermatology";
  if (s === "other") return "other";
  warn("unknown_department");
  return null;
}

function mapPapResult(
  v: unknown,
  warn: (c: string) => void,
): "positive" | "negative" | "pending" | "not_available" | null {
  const s = slug(v);
  if (!s) return null;
  if (s.startsWith("not_available")) return "not_available";
  if (s === "positive" || s === "negative" || s === "pending") return s;
  warn("unknown_pap_result");
  return null;
}

/** 1..10 or null; an out-of-range legacy value is dropped (never clamped) with a warning. */
function score(v: unknown, warn: (c: string) => void): number | null {
  const n = toInt(v);
  if (n === null) return null;
  if (n < 1 || n > 10) {
    warn("score_out_of_range");
    return null;
  }
  return n;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Doctors → specialists
// ---------------------------------------------------------------------------

/**
 * PTF.Doctors → specialists. No `external_id` (the Airtable table has no Unite id): the Unite
 * doctor sync adopts a specialist by name later. Branch is not imported (specialist_locations needs
 * working hours and locations created in Settings); it shows up in mapping coverage.
 */
export const doctorsMapper: TableMapper = {
  key: "ptf.doctors",
  name: "PTF · Doctors",
  baseId: BASE.ptf,
  tableId: "tblhoMqQ1jgiCGHGY",
  target: "specialists",
  status: "ready",
  naturalKey: ["name"],
  fields: [{ id: "fld0ghl5SVDzYlwU0", column: "name", required: true }],
  links: [
    {
      kind: "lookup",
      fieldId: "fldkfam3qESHnrbTr",
      label: "Specialty → department",
      column: "department_id",
      table: "departments",
      matchColumn: "name",
    },
  ],
};

// ---------------------------------------------------------------------------
// Unite.Medical Records Data → visits
// ---------------------------------------------------------------------------

const MRD = {
  height: "fldJajCqvONmaX3XL",
  weight: "fldzdjzBPCdvG9U8U",
  temp: "fldQWA9jjupL6EF3L",
  pulse: "fldOVaKPQc3VUwJnh",
  bpSys: "fldQEoJfTLKODHoq7",
  bpDia: "fldz0AtfcKuYy52FV",
  spo2: "fldFzXAhtt2fcRTDy",
  items: "fld5GjbpREf5EvHRS",
} as const;

export const medicalRecordsMapper: TableMapper = {
  key: "unite.medical_records",
  name: "Unite · Medical Records Data (visits)",
  baseId: BASE.unite,
  tableId: "tblllKPKIY9qvMoEU",
  target: "visits",
  status: "ready",
  // visits.external_id = the MRD Airtable record id (data-model-mapping §1.2). See the open
  // question in docs/06_PHASE_9_NOTES.md about the future Unite visit sync.
  naturalKey: ["external_id"],
  dependsOn: [PATIENTS, "ptf.doctors"],
  fields: [
    { id: "fldKuI5eXoDJIiOcu", column: "visit_date", convert: (v) => toDate(v), required: true },
    { id: "fld5eftp6BVHSyPQd", column: "description" },
    { id: "fldZsPHI9BBzWWgap", column: "complaints" },
    { id: "fldX8Chw8INeRhuTD", column: "nurse_notes" },
    { id: "fld5ONgPlFlyJFZYy", column: "doctor_notes" },
    { id: "fldx5AdhYb49W946I", column: "therapy_notes" },
    { id: "fldVWIrd7336dmS6x", column: "procedure_notes" },
    { id: "fldpNQHsUjrA9XG8a", column: "physical_exam_notes" },
    { id: "fldJQiC2fplhNXa1N", column: "hpi" },
    { id: "fldUGZGwjklowwHJI", column: "review_of_systems" },
    { id: "fldhDyDyi1V5soDiO", column: "plan_of_treatment" },
    { id: "fldZiy0HG9KGApOtc", column: "doctor_name" },
    { id: "fldSIH4uHnviEYYel", column: "primary_diagnosis_code" },
  ],
  // Read in finalize: vitals strings and the Items link (for investigation_count).
  extraFieldIds: Object.values(MRD),
  links: [
    {
      kind: "record",
      fieldId: "fldtxNjAanspw8h40",
      label: "Unite (patient)",
      target: PATIENTS,
      column: "contact_id",
    },
    {
      kind: "lookup",
      fieldId: "fldZiy0HG9KGApOtc",
      label: "Doctor → specialist",
      column: "specialist_id",
      table: "specialists",
      matchColumn: "name",
    },
  ],
  finalize(values, raw, warn, recordId) {
    values.external_id = recordId;
    values.source = "airtable";

    // Vitals: Unite sends strings. Anything outside the plausibility windows (which mirror the CHECK
    // constraints) is dropped with a warning code instead of failing the whole row; blank stays NULL.
    const drop = (name: string) => warn(`vital_dropped:${name}`);
    const text = (id: string) => toText(raw[id]);
    const vital = (
      name: string,
      id: string,
      range: readonly [number, number],
      dp: number | null,
    ) => {
      const t = text(id);
      const n = parseVital(t, range);
      if (t && n === null) drop(name);
      return n === null ? null : dp === null ? Math.round(n) : round1(n);
    };
    values.height_cm = vital("height", MRD.height, [20, 260], 1);
    values.weight_kg = vital("weight", MRD.weight, [0.2, 500], 1);
    values.temp_c = vital("temp", MRD.temp, PLAUSIBLE.temp, 1);
    values.pulse = vital("pulse", MRD.pulse, PLAUSIBLE.pulse, null);
    values.spo2 = vital("spo2", MRD.spo2, PLAUSIBLE.spo2, null);
    const bp = parseBp(text(MRD.bpSys), text(MRD.bpDia));
    if ((text(MRD.bpSys) || text(MRD.bpDia)) && bp.systolic === null) drop("bp");
    values.bp_systolic = bp.systolic;
    values.bp_diastolic = bp.diastolic;

    const rawVitals = Object.fromEntries(
      Object.entries({
        height: text(MRD.height),
        weight: text(MRD.weight),
        temp: text(MRD.temp),
        pulse: text(MRD.pulse),
        bp_systolic: text(MRD.bpSys),
        bp_diastolic: text(MRD.bpDia),
        spo2: text(MRD.spo2),
      }).filter(([, v]) => v !== ""),
    );
    values.vitals_raw = rawVitals;

    const items = raw[MRD.items];
    values.investigation_count = Array.isArray(items) ? items.length : 0;
  },
};

// ---------------------------------------------------------------------------
// Acute.Visits (derived copies of MRD rows): only what MRD lacks
// ---------------------------------------------------------------------------

/**
 * Acute.Visits are derived copies of the MRD rows (Visit ID = MRD record id), so this mapper adopts
 * the MRD visit and adds only the columns MRD does not have. It never writes vitals, notes or the
 * doctor: two tables fighting over the same column would make every re-run an update.
 */
export const acuteVisitsMapper: TableMapper = {
  key: "acute.visits",
  name: "Acute · Visits (derived)",
  baseId: BASE.acute,
  tableId: "tblyOweSP3FfeY9q0",
  target: "visits",
  status: "ready",
  naturalKey: ["external_id"],
  fillBlankOnly: ["visit_date"],
  dependsOn: ["unite.medical_records"],
  testFlagFieldId: "fldAjZRrsEvuCtcVR",
  fields: [
    { id: "fldRPRNAgGU7aaSQe", column: "external_id", required: true },
    { id: "fldXlyyw4yhhwby2g", column: "visit_date", convert: (v) => toDate(v), required: true },
    { id: "fldfDoqBTP05oHIhJ", column: "department_raw" },
    {
      id: "fldgZRyGr1tVmNbYk",
      column: "pap_result",
      convert: (v, warn) => mapPapResult(v, warn),
    },
    { id: "fld2al0GgsV6g4Rdi", column: "symptomatic", convert: (v) => toBool(v, true) },
    { id: "flduu0Nv3L4JCMitD", column: "primary_diagnosis_text" },
    { id: "fldXAkFSh3q9dlkEC", column: "secondary_diagnosis_codes" },
    { id: "fldAjZRrsEvuCtcVR", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  finalize(values, raw, warn) {
    values.source = "airtable";
    values.department_mapped = mapDepartmentEnum(raw["fldfDoqBTP05oHIhJ"], warn);
  },
};

// ---------------------------------------------------------------------------
// Acute.Prescriptions → prescriptions
// ---------------------------------------------------------------------------

const RX_CLASS_FIELD = "fld7K9SVDvqjaU30A";

export const acutePrescriptionsMapper: TableMapper = {
  key: "acute.prescriptions",
  name: "Acute · Prescriptions",
  baseId: BASE.acute,
  tableId: "tblQra08AflxuXxQq",
  target: "prescriptions",
  status: "ready",
  createOnly: true,
  naturalKey: ["external_key"],
  dependsOn: ["acute.visits", ACUTE_PATIENTS, "acute.medication_reference"],
  testFlagFieldId: "fldYGZHkRjicwBPz6",
  fields: [
    { id: "fldPLUnLoIBIUfcfT", column: "external_key", required: true },
    { id: "fldNp6WqXyDjupsue", column: "medication_code" },
    { id: "fldTp7F5vU2efpLY8", column: "medication_name" },
    { id: "fldfujiLktvFEPNE1", column: "duration_days", convert: (v) => toInt(v) },
    { id: "fldbHnnCairp1oMA2", column: "dosage_instruction" },
    { id: "fldfYDjKPKJn9vPPU", column: "total_quantity", convert: (v) => toNumber(v) },
    { id: "fldM5leoAtTzhVg6R", column: "start_date", convert: (v) => toDate(v) },
    { id: "fldYGZHkRjicwBPz6", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  // The Airtable class is read only to warn when it disagrees with the reference table.
  extraFieldIds: [RX_CLASS_FIELD],
  links: [
    {
      kind: "record",
      fieldId: "fldYBAQSnbjTmxsq0",
      label: "Visit",
      target: "acute.visits",
      column: "visit_id",
      required: true,
    },
    {
      kind: "record",
      fieldId: "fldYe4toZohBlfMrg",
      label: "Patient",
      target: ACUTE_PATIENTS,
      column: "contact_id",
    },
  ],
  finalize(values) {
    values.source = "airtable_acute";
    // "<MRD record id>-<n>": n is the position within the visit.
    const m = String(values.external_key ?? "").match(/-(\d+)$/);
    values.position = m ? Number(m[1]) : null;
  },
  async enrich({ values, raw, store, warn }) {
    // R-05: the class comes from ref_medication_classes by code. The Airtable value is a
    // name-based heuristic that must never drive a sequence, so it is ignored (only compared).
    const code = typeof values.medication_code === "string" ? values.medication_code : null;
    const ref = code
      ? await store.findOne("ref_medication_classes", { unite_local_code: code })
      : null;
    const refClass = typeof ref?.class === "string" ? ref.class : "unclassified";
    values.class = refClass;
    const airtable = slug(raw[RX_CLASS_FIELD]);
    if (refClass === "unclassified" && (airtable === "antibiotic" || airtable === "steroid"))
      warn("class_not_in_reference");
  },
};

// ---------------------------------------------------------------------------
// Acute.Follow-Up Queue → clinical_followups
// ---------------------------------------------------------------------------

const FU_VISIT_LINK = "fldZouRo0kxRzIB80";

export const acuteFollowupMapper: TableMapper = {
  key: "acute.followup_queue",
  name: "Acute · Follow-Up Queue",
  baseId: BASE.acute,
  tableId: "tblgX6wIqWefpwrBg",
  target: "clinical_followups",
  status: "ready",
  createOnly: true,
  // `ref` is not unique in the table and could collide with an engine row ('FU-…'), so rows are
  // matched through external_refs only.
  naturalKey: [],
  dependsOn: ["acute.visits", ACUTE_PATIENTS],
  testFlagFieldId: "fldJDp2lrt0n3YY1z",
  fields: [
    { id: "fldXCi8apfSF1wGLH", column: "ref", required: true },
    {
      id: "fldNOnLLHzKuEapJX",
      column: "trigger_category",
      convert: (v, warn) => mapTriggerCategory(v, warn),
    },
    { id: "fldX94COawJmYp0kb", column: "priority", convert: (v, warn) => mapPriority(v, warn) },
    { id: "fldOVqtqfwRc7lOxx", column: "due_date", convert: (v) => toDate(v) },
    {
      id: "fldoS3vnm2UmJI21S",
      column: "call_status",
      convert: (v, warn) => mapCallStatus(v, warn),
    },
    { id: "fldbMjWZfeQfBYvJZ", column: "outcome", convert: (v, warn) => mapOutcome(v, warn) },
    { id: "fldKoC0xMVSjhKZ1g", column: "doctor_alert_required", convert: (v) => toBool(v) },
    { id: "fldGJirPqdjyTo3e0", column: "notes" },
    { id: "fldJDp2lrt0n3YY1z", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  // The "Doctor Notified" checkbox is read in finalize (→ doctor_notified_at).
  extraFieldIds: ["fldwfriyDgawIslbQ"],
  links: [
    {
      kind: "record",
      fieldId: FU_VISIT_LINK,
      label: "Visit",
      target: "acute.visits",
      column: "visit_id",
    },
    {
      kind: "record",
      fieldId: "fldcR5cyDiuO4LDlO",
      label: "Patient",
      target: ACUTE_PATIENTS,
      column: "contact_id",
    },
    {
      kind: "lookup",
      fieldId: "fldckx3vmXjysOFzf",
      label: "Assigned team",
      column: "assigned_team_id",
      table: "teams",
      matchColumn: "name",
    },
  ],
  finalize(values, raw, warn, _id, createdTime) {
    // Never the default 'engine': the engine closes untouched engine-owned rows.
    values.source = "airtable_acute";
    const created = createdTime ?? EPOCH;
    if (toBool(raw["fldwfriyDgawIslbQ"])) values.doctor_notified_at = toDateTime(created);

    // Open only when Airtable says it is genuinely pending (and not a test row). Anything else,
    // including an unrecognised status, is imported CLOSED so history never floods the live queue.
    const open = values.call_status === "pending" && values.is_test_record !== true;
    if (open) {
      warn("followup_imported_open");
      values.closed_at = null;
      values.closed_reason = null;
    } else {
      values.closed_at = toDateTime(created);
      values.closed_reason = "airtable_history";
    }
  },
  async enrich({ values, resolved, store, warn }) {
    // Phase 6 dedupe key (R-11): <visit external id>-<category>. With the same key the engine adopts
    // an open row instead of raising a duplicate.
    const category = values.trigger_category as TriggerCategory | null;
    const visitId = resolved[FU_VISIT_LINK]?.[0];
    if (!category) return;
    const visit = visitId ? await store.getRow("visits", visitId) : null;
    if (visit && typeof visit.external_id === "string")
      values.dedupe_key = dedupeKey(visit.external_id, category);
    else warn("followup_no_dedupe_key");
  },
};

// ---------------------------------------------------------------------------
// Acute.Feedback & Outcomes → clinical_feedback
// ---------------------------------------------------------------------------

export const acuteFeedbackMapper: TableMapper = {
  key: "acute.feedback",
  name: "Acute · Feedback & Outcomes",
  baseId: BASE.acute,
  tableId: "tbluNXftGwkP9rJDV",
  target: "clinical_feedback",
  status: "ready",
  createOnly: true,
  naturalKey: [],
  dependsOn: ["acute.prescriptions", "acute.visits", ACUTE_PATIENTS],
  testFlagFieldId: "fld1HTj2zNEKN9jjP",
  fields: [
    { id: "fldRthKkY016ceRta", column: "ref" },
    // stage is NOT NULL with no default: an unrecognised stage makes the record invalid (reported).
    {
      id: "fldeR3gUWc5H3cRDh",
      column: "stage",
      convert: (v, warn) => mapFeedbackStage(v, warn),
      required: true,
    },
    { id: "fld0yu7tTxBdtds2e", column: "score", convert: (v, warn) => score(v, warn) },
    { id: "fldvGMaOXbeZKCZ13", column: "symptoms_reported" },
    { id: "fldwRxxa94xztwfpr", column: "side_effects_flagged", convert: (v) => toBool(v) },
    { id: "fld1HTj2zNEKN9jjP", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  // Notification checkboxes + timestamp are read in finalize.
  extraFieldIds: ["fld0Hyt8i9QjKFPuB", "flduYSDkd6Uc8VzPf", "fldq8lgUIHlHSc75b"],
  links: [
    {
      kind: "record",
      fieldId: "fldFaPDTjSAkSL3Zl",
      label: "Patient",
      target: ACUTE_PATIENTS,
      column: "contact_id",
    },
    {
      kind: "record",
      fieldId: "fldmRIAqu1fLwd44F",
      label: "Related Prescription",
      target: "acute.prescriptions",
      column: "prescription_id",
    },
    {
      kind: "record",
      fieldId: "fld5DKPuB27ioYfn9",
      label: "Related Visit",
      target: "acute.visits",
      column: "visit_id",
    },
  ],
  finalize(values, raw, _warn, _id, createdTime) {
    // History records that someone WAS notified; it never notifies anyone now (the engine's
    // red-flag path is not called by the importer, and needs_doctor_review is engine-owned).
    const notifiedAt = toDateTime(raw["fldq8lgUIHlHSc75b"]) ?? toDateTime(createdTime ?? EPOCH);
    if (toBool(raw["fld0Hyt8i9QjKFPuB"])) values.doctor_notified_at = notifiedAt;
    if (toBool(raw["flduYSDkd6Uc8VzPf"])) values.coordinator_notified_at = notifiedAt;
  },
};

// ---------------------------------------------------------------------------
// Acute.Message Log → clinical_message_log (terminal history only)
// ---------------------------------------------------------------------------

export const acuteMessageLogMapper: TableMapper = {
  key: "acute.message_log",
  name: "Acute · Message Log",
  baseId: BASE.acute,
  tableId: "tblXNWAh1hdaueUbs",
  target: "clinical_message_log",
  status: "ready",
  createOnly: true,
  // (org_id, idempotency_key) is unique in the table; keeping the Airtable key (the documented
  // "<prescription or visit external key>:<template key>" scheme) also blocks a future re-send.
  naturalKey: ["idempotency_key"],
  dependsOn: ["acute.prescriptions", "acute.visits", ACUTE_PATIENTS],
  testFlagFieldId: "fldIICnc9N59HHUoH",
  fields: [
    { id: "fld0vFJUNeSuuwaRG", column: "ref" },
    { id: "fldU0k0N5b3RiqfOl", column: "template_key", required: true },
    { id: "fldYJRG3KcI8YyQbo", column: "idempotency_key", required: true },
    {
      id: "fld10J2UlPe3KH1gn",
      column: "trigger_category",
      convert: (v, warn) => mapTriggerCategory(v, warn),
    },
    { id: "fldZ1PwpI2xNXRm4I", column: "scheduled_at", convert: (v) => toDateTime(v) },
    { id: "fldBN7AFKvB77rHaV", column: "sent_at", convert: (v) => toDateTime(v) },
    // Verbatim patient text (PHI): stored, never logged, counted or reported.
    { id: "fld5hfgCqvHX5R8Fo", column: "reply_text" },
    { id: "fldQgZnNj0k86Wckg", column: "reply_parsed_score", convert: (v, warn) => score(v, warn) },
    { id: "fldIICnc9N59HHUoH", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  extraFieldIds: ["fldigImLLUJ11a6ce", "fld8DkJbXI3agZomH"],
  links: [
    {
      kind: "record",
      fieldId: "flduUsU2TEoOlSKEK",
      label: "Patient",
      target: ACUTE_PATIENTS,
      column: "contact_id",
    },
    {
      kind: "record",
      fieldId: "fldxhgwdwSbGJPR6d",
      label: "Visit",
      target: "acute.visits",
      column: "visit_id",
    },
    {
      kind: "record",
      fieldId: "fldrdxterwqjkh020",
      label: "Prescription",
      target: "acute.prescriptions",
      column: "prescription_id",
    },
  ],
  finalize(values, raw, warn) {
    // Terminal statuses only: a 'scheduled' row would look like pending work.
    const delivered = toBool(raw["fldigImLLUJ11a6ce"]);
    if (delivered) values.status = "delivered";
    else if (values.sent_at) values.status = "sent";
    else {
      values.status = "cancelled";
      values.block_reason = "not_sent_in_airtable";
    }
    // The table forbids a test record marked live+sent; history of real rows is 'live'.
    values.send_mode = values.is_test_record === true ? "test" : "live";
    if (toBool(raw["fld8DkJbXI3agZomH"]) && !values.reply_text) warn("replied_without_text");
  },
};

// ---------------------------------------------------------------------------
// Acute.Message Templates → clinical_call_scripts (FU_* only)
// ---------------------------------------------------------------------------

/**
 * Only the FU_* rows are call scripts. The WhatsApp template rows (RX_START, ABX_DAY3, …) are
 * rebuilt in the Phase 4 template builder and linked by `internal_key`; they are skipped here.
 * An Airtable "approved" is not imported: approval is a Pulse action, so scripts start 'awaiting'.
 */
export const callScriptsMapper: TableMapper = {
  key: "acute.message_templates",
  name: "Acute · Message Templates (call scripts)",
  baseId: BASE.acute,
  tableId: "tblnCsSkyw4Tu9Ak7",
  target: "clinical_call_scripts",
  status: "ready",
  naturalKey: ["key"],
  fields: [
    { id: "fldgpCwM1uG424pKz", column: "key", required: true },
    { id: "fldtnpNhYCdu8Sdbr", column: "purpose" },
    { id: "fldyfsVBI5CP4L8GM", column: "script" },
    { id: "fldruCMCoDqzTEtgH", column: "phase", convert: (v) => toInt(v) },
    { id: "fldHKolWfL6RVnBHQ", column: "notes" },
  ],
  extraFieldIds: ["fld1lj7DaZSAaJRME"],
  finalize(values, raw, warn) {
    values.clinical_approval = "awaiting";
    if (/^approved$/i.test(toText(raw["fld1lj7DaZSAaJRME"])))
      warn("airtable_approval_not_imported");
  },
  skip(values) {
    if (!String(values.key ?? "").startsWith("FU_")) return "not_a_call_script";
    if (!values.script) return "call_script_without_copy";
    return null;
  },
};
