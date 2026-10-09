/**
 * Mappers whose target tables are created in Phase 6 (supabase/drafts 0102/0103). They are fully
 * mapped and unit-tested now so a dry-run against real data validates the field map, link
 * resolution and warnings long before cut-over. A real run skips them ("target not migrated").
 */
import { parseBp, slug, toBool, toDate, toDateTime, toInt, toNumber, toText } from "../convert";
import { BASE } from "./bases";
import type { TableMapper } from "./types";

const PATIENTS = "unite.patients";

function bpFromRaw(
  values: Record<string, unknown>,
  raw: Record<string, unknown>,
  sys: string,
  dia: string,
) {
  const sysText = toText(raw[sys]);
  const diaText = toText(raw[dia]);
  // Unite sends "92/61" in either field (R-01); a bare number in the diastolic field is just diastolic.
  const [s, d] = parseBp(sysText.includes("/") ? sysText : diaText.includes("/") ? diaText : "");
  values.bp_systolic = sysText.includes("/") || diaText.includes("/") ? s : toInt(sysText);
  values.bp_diastolic = sysText.includes("/") || diaText.includes("/") ? d : toInt(diaText);
}

export const medicalRecordsMapper: TableMapper = {
  key: "unite.medical_records",
  name: "Unite · Medical Records Data (visits)",
  baseId: BASE.unite,
  tableId: "tblllKPKIY9qvMoEU",
  target: "visits",
  status: "pending_phase6",
  naturalKey: ["external_id"],
  dependsOn: [PATIENTS, "unite.diagnosis", "unite.medication", "unite.items"],
  fields: [
    { id: "fldKuI5eXoDJIiOcu", column: "visit_date", convert: (v) => toDate(v), required: true },
    { id: "fldJajCqvONmaX3XL", column: "height_cm", convert: (v) => toNumber(v) },
    { id: "fldzdjzBPCdvG9U8U", column: "weight_kg", convert: (v) => toNumber(v) },
    { id: "fldQWA9jjupL6EF3L", column: "temp_c", convert: (v) => toNumber(v) },
    { id: "fldOVaKPQc3VUwJnh", column: "pulse", convert: (v) => toInt(v) },
    { id: "fldFzXAhtt2fcRTDy", column: "spo2", convert: (v) => toInt(v) },
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
    { id: "fldTVFyiKlZAhzUe6", column: "legacy_acute_synced_on", convert: (v) => toDate(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldtxNjAanspw8h40",
      label: "Unite (patient)",
      target: PATIENTS,
      column: "contact_id",
    },
    { kind: "record", fieldId: "fldsrglawqYEoNqZu", label: "Diagnosis", target: "unite.diagnosis" },
    {
      kind: "record",
      fieldId: "fldDJcDJYLqffQ5A0",
      label: "Primary Diagnosis Link",
      target: "unite.diagnosis",
    },
    {
      kind: "record",
      fieldId: "fldIBSKJNAyz1kKlo",
      label: "Medication",
      target: "unite.medication",
    },
    { kind: "record", fieldId: "fld5GjbpREf5EvHRS", label: "Items", target: "unite.items" },
  ],
  finalize(values, raw, _warn, recordId) {
    values.external_id = recordId; // visits.external_id = the MRD Airtable record id
    bpFromRaw(values, raw, "fldQEoJfTLKODHoq7", "fldz0AtfcKuYy52FV");
  },
};

/** Acute.Visits are derived copies of MRD rows, imported only to reconcile engine output. */
export const acuteVisitsMapper: TableMapper = {
  key: "acute.visits",
  name: "Acute · Visits (derived)",
  baseId: BASE.acute,
  tableId: "tblyOweSP3FfeY9q0",
  target: "visits",
  status: "pending_phase6",
  naturalKey: ["external_id"],
  dependsOn: ["unite.medical_records"],
  testFlagFieldId: "fldAjZRrsEvuCtcVR",
  fields: [
    { id: "fldRPRNAgGU7aaSQe", column: "external_id", required: true },
    { id: "fldXlyyw4yhhwby2g", column: "visit_date", convert: (v) => toDate(v) },
    { id: "fldfDoqBTP05oHIhJ", column: "department_mapped", convert: (v) => slug(v) || null },
    { id: "fld56HJ56HDz5ICqX", column: "doctor_name" },
    { id: "fldW2drDyJO7x4Bhn", column: "temp_c", convert: (v) => toNumber(v) },
    { id: "fld4MabuolV2ia0hn", column: "bp_systolic", convert: (v) => toInt(v) },
    { id: "fld0uMrH7Uu9lCxdv", column: "bp_diastolic", convert: (v) => toInt(v) },
    { id: "fldfGYvo9oW5pFvMY", column: "spo2", convert: (v) => toInt(v) },
    { id: "fldzTCJ2RDTiyZV6p", column: "pulse", convert: (v) => toInt(v) },
    { id: "fldx908qYxc9kT74t", column: "primary_diagnosis_code" },
    { id: "flduu0Nv3L4JCMitD", column: "primary_diagnosis_text" },
    { id: "fldXAkFSh3q9dlkEC", column: "secondary_diagnosis_codes" },
    { id: "fldyu2FVfEijTqWUR", column: "procedure_notes" },
    { id: "fldutfsNvr26p8pLy", column: "plan_of_treatment" },
    { id: "fldgZRyGr1tVmNbYk", column: "pap_result", convert: (v) => slug(v) || null },
    { id: "fld2al0GgsV6g4Rdi", column: "symptomatic", convert: (v) => toBool(v) },
    { id: "fldAjZRrsEvuCtcVR", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldpEvjq9SHOLAD7h",
      label: "Patient",
      target: "acute.patients",
      column: "contact_id",
    },
  ],
};

export const acutePrescriptionsMapper: TableMapper = {
  key: "acute.prescriptions",
  name: "Acute · Prescriptions",
  baseId: BASE.acute,
  tableId: "tblQra08AflxuXxQq",
  target: "prescriptions",
  status: "pending_phase6",
  naturalKey: ["external_key"],
  dependsOn: ["acute.visits", "acute.patients"],
  testFlagFieldId: "fldYGZHkRjicwBPz6",
  fields: [
    { id: "fldPLUnLoIBIUfcfT", column: "external_key", required: true },
    { id: "fldNp6WqXyDjupsue", column: "medication_code" },
    { id: "fldTp7F5vU2efpLY8", column: "medication_name" },
    {
      id: "fld7K9SVDvqjaU30A",
      column: "class",
      // fail closed: anything not explicitly classified is unclassified
      convert: (v) => {
        const s = slug(v);
        return ["antibiotic", "steroid", "probiotic", "supplement", "enzyme", "other"].includes(s)
          ? s
          : "unclassified";
      },
    },
    { id: "fldfujiLktvFEPNE1", column: "duration_days", convert: (v) => toInt(v) },
    { id: "fldbHnnCairp1oMA2", column: "dosage_instruction" },
    { id: "fldfYDjKPKJn9vPPU", column: "total_quantity", convert: (v) => toNumber(v) },
    { id: "fldM5leoAtTzhVg6R", column: "start_date", convert: (v) => toDate(v) },
    { id: "fldwNVLgPMpESN3Hz", column: "requires_probiotics", convert: (v) => toBool(v) },
    { id: "fld2u0WCiQkYkHbHf", column: "probiotic_duration_days", convert: (v) => toInt(v) },
    { id: "fldWHAoxbXpISk6FS", column: "sequence_status", convert: (v) => slug(v) || null },
    { id: "fldwrqZebkNcCcvD3", column: "day3_score", convert: (v) => toInt(v) },
    { id: "fldsB3CbqdZspzYLK", column: "outcome_score", convert: (v) => toInt(v) },
    { id: "fldYGZHkRjicwBPz6", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldYe4toZohBlfMrg",
      label: "Patient",
      target: "acute.patients",
      column: "contact_id",
    },
    {
      kind: "record",
      fieldId: "fldYBAQSnbjTmxsq0",
      label: "Visit",
      target: "acute.visits",
      column: "visit_id",
    },
  ],
};

export const ptfPrescriptionsMapper: TableMapper = {
  key: "ptf.prescriptions",
  name: "PTF · Prescriptions (history)",
  baseId: BASE.ptf,
  tableId: "tblRNJcasTIz0vLhR",
  target: "prescriptions",
  status: "pending_phase6",
  naturalKey: ["external_key"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldocMh0yomOPBDUf", column: "external_key", required: true },
    { id: "fldCHoABZoNlSc66w", column: "medication_name" },
    {
      id: "fldwOw2vmR6QKpriS",
      column: "class",
      convert: (v) => {
        const s = slug(v);
        return ["antibiotic", "supplement", "enzyme", "other"].includes(s) ? s : "unclassified";
      },
    },
    { id: "fldQTu2pq7Uo5cJ4v", column: "duration_days", convert: (v) => toInt(v) },
    { id: "fld9Gu0v5MiCutpAn", column: "start_date", convert: (v) => toDate(v) },
    { id: "fldn1CALuXkS6iPYo", column: "prescription_date", convert: (v) => toDate(v) },
    { id: "fldygMAMVayc6C66S", column: "dosage" },
    { id: "fld0SS6knzf0ofBrM", column: "frequency" },
    { id: "fldlmtYSBoJboygdz", column: "requires_probiotics", convert: (v) => toBool(v) },
    {
      id: "fldbia9AfcKOE0B8z",
      column: "sequence_status",
      convert: (v) => (slug(v) === "completed" ? "complete" : "not_started"),
    },
    { id: "fldi63hCyya30zCz8", column: "notes_for_patient" },
  ],
  finalize(values) {
    // Start Date wins; fall back to Prescription Date. Dosage + frequency join into one instruction.
    values.start_date ??= values.prescription_date;
    delete values.prescription_date;
    values.dosage_instruction = [values.dosage, values.frequency].filter(Boolean).join(" ") || null;
    delete values.dosage;
    delete values.frequency;
    values.source = "legacy_ptf";
  },
  links: [
    {
      kind: "record",
      fieldId: "fldSNEMvtKxKi5UFO",
      label: "Patient",
      target: PATIENTS,
      column: "contact_id",
    },
  ],
};

const TRIGGER_CATEGORIES = [
  "paediatric_high_concern",
  "bleeding",
  "vitals",
  "infection_labs",
  "post_procedure",
  "clinical_check",
];

export const acuteFollowupMapper: TableMapper = {
  key: "acute.followup_queue",
  name: "Acute · Follow-Up Queue",
  baseId: BASE.acute,
  tableId: "tblgX6wIqWefpwrBg",
  target: "clinical_followups",
  status: "pending_phase6",
  naturalKey: ["ref"],
  dependsOn: ["acute.visits", "acute.patients"],
  testFlagFieldId: "fldJDp2lrt0n3YY1z",
  fields: [
    { id: "fldXCi8apfSF1wGLH", column: "ref", required: true },
    {
      id: "fldNOnLLHzKuEapJX",
      column: "trigger_category",
      convert: (v, warn) => {
        const s = slug(v);
        if (s && !TRIGGER_CATEGORIES.includes(s)) warn("unknown_trigger_category");
        return s || null;
      },
    },
    { id: "fldX94COawJmYp0kb", column: "priority", convert: (v) => slug(v) || null },
    { id: "fldOVqtqfwRc7lOxx", column: "due_date", convert: (v) => toDate(v) },
    { id: "fldckx3vmXjysOFzf", column: "assigned_team_name" },
    { id: "fldoS3vnm2UmJI21S", column: "call_status", convert: (v) => slug(v) || null },
    { id: "fldbMjWZfeQfBYvJZ", column: "outcome", convert: (v) => slug(v) || null },
    { id: "fldKoC0xMVSjhKZ1g", column: "doctor_alert_required", convert: (v) => toBool(v) },
    { id: "fldwfriyDgawIslbQ", column: "doctor_notified", convert: (v) => toBool(v) },
    { id: "fldGJirPqdjyTo3e0", column: "notes" },
    { id: "fldJDp2lrt0n3YY1z", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldZouRo0kxRzIB80",
      label: "Visit",
      target: "acute.visits",
      column: "visit_id",
    },
    {
      kind: "record",
      fieldId: "fldcR5cyDiuO4LDlO",
      label: "Patient",
      target: "acute.patients",
      column: "contact_id",
    },
  ],
};

export const cfuFollowupMapper: TableMapper = {
  key: "cfu.followup_queue",
  name: "CFU · Follow-Up Queue (history)",
  baseId: BASE.cfu,
  tableId: "tblJvIh3Wf7z8Qn8k",
  target: "clinical_followups",
  status: "pending_phase6",
  naturalKey: ["ref"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fld6OhLP42w2HIQSe", column: "patient_pin" },
    { id: "fldsCFssERLY68rxI", column: "visit_date", convert: (v) => toDate(v) },
    { id: "fldhXWgslD9v3BSzK", column: "due_date", convert: (v) => toDate(v) },
    { id: "fldnzYPCN4lf0C9Dj", column: "assigned_team_name" },
    { id: "fldjPQXHBjuUJRLNq", column: "call_status", convert: (v) => slug(v) || null },
    { id: "fldkPuFbyq2tntnUN", column: "outcome", convert: (v) => slug(v) || null },
    { id: "fldAH6K7B4jUIVRO1", column: "doctor_alert_required", convert: (v) => toBool(v) },
    { id: "fldQ6rcJt7yGrvB2H", column: "notes" },
    { id: "fldVSf9u8lD3O97vp", column: "escalation_status", convert: (v) => slug(v) || null },
    { id: "fldfDWGbyIjyUKGy5", column: "doctor_response_notes" },
  ],
  finalize(values, raw) {
    values.source = "legacy_cfu";
    // No natural id in this prototype table: the Airtable record id is the idempotency key.
    values.ref = `cfu-${toText(raw["fld6OhLP42w2HIQSe"]) || "unknown"}-${values.visit_date ?? "undated"}`;
  },
};

export const acuteFeedbackMapper: TableMapper = {
  key: "acute.feedback",
  name: "Acute · Feedback & Outcomes",
  baseId: BASE.acute,
  tableId: "tbluNXftGwkP9rJDV",
  target: "clinical_feedback",
  status: "pending_phase6",
  naturalKey: ["ref"],
  dependsOn: ["acute.prescriptions", "acute.visits", "acute.patients"],
  testFlagFieldId: "fld1HTj2zNEKN9jjP",
  fields: [
    { id: "fldRthKkY016ceRta", column: "ref", required: true },
    { id: "fldeR3gUWc5H3cRDh", column: "stage", convert: (v) => slug(v) || null },
    {
      id: "fld0yu7tTxBdtds2e",
      column: "score",
      // the table check constraint is 1..10; an out-of-range legacy value is dropped, not clamped
      convert: (v, warn) => {
        const n = toInt(v);
        if (n !== null && (n < 1 || n > 10)) {
          warn("score_out_of_range");
          return null;
        }
        return n;
      },
    },
    { id: "fldvGMaOXbeZKCZ13", column: "symptoms_reported" },
    { id: "fldwRxxa94xztwfpr", column: "side_effects_flagged", convert: (v) => toBool(v) },
    { id: "fld0Hyt8i9QjKFPuB", column: "doctor_notified", convert: (v) => toBool(v) },
    { id: "flduYSDkd6Uc8VzPf", column: "coordinator_notified", convert: (v) => toBool(v) },
    { id: "fldq8lgUIHlHSc75b", column: "notified_at", convert: (v) => toDateTime(v) },
    { id: "fld1HTj2zNEKN9jjP", column: "is_test_record", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldFaPDTjSAkSL3Zl",
      label: "Patient",
      target: "acute.patients",
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
};

export const ptfFeedbackMapper: TableMapper = {
  key: "ptf.feedback",
  name: "PTF · Feedback & Outcomes (history)",
  baseId: BASE.ptf,
  tableId: "tbleAP5BLA6Juf8B1",
  target: "clinical_feedback",
  status: "pending_phase6",
  naturalKey: ["ref"],
  dependsOn: ["ptf.prescriptions", PATIENTS],
  fields: [
    { id: "fld6n4xoPkQb9ywO3", column: "ref", required: true },
    {
      id: "fldxevmV7Q0wJKa7X",
      column: "stage",
      convert: (v) => {
        const s = slug(v);
        return s === "during_treatment" ? "day3_antibiotics" : s || null;
      },
    },
    { id: "fldTdafMk8XX6cWXW", column: "score", convert: (v) => toInt(v) },
    { id: "fldJmrHi2sP0foSH3", column: "symptoms_improved", convert: (v) => toBool(v, true) },
    { id: "fldTgwb7mtTODJwWD", column: "symptoms_reported" },
    { id: "fld729Xo5RK0jfsJB", column: "needs_doctor_review", convert: (v) => toBool(v) },
    { id: "fldISlSLzLM8HTLHZ", column: "notes" },
  ],
  finalize(values) {
    values.side_effects_flagged = !!values.symptoms_reported;
    values.doctor_notified = !!values.notes;
    values.source = "legacy_ptf";
  },
  links: [
    {
      kind: "record",
      fieldId: "fldAwEMZ2NXh5X2pv",
      label: "Patient",
      target: PATIENTS,
      column: "contact_id",
    },
    {
      kind: "record",
      fieldId: "fldeycrfzKSQsqGdz",
      label: "Related Prescription",
      target: "ptf.prescriptions",
      column: "prescription_id",
    },
  ],
};

export const acuteMessageLogMapper: TableMapper = {
  key: "acute.message_log",
  name: "Acute · Message Log",
  baseId: BASE.acute,
  tableId: "tblXNWAh1hdaueUbs",
  target: "clinical_message_log",
  status: "pending_phase6",
  naturalKey: ["idempotency_key"],
  dependsOn: ["acute.prescriptions", "acute.visits", "acute.patients"],
  testFlagFieldId: "fldIICnc9N59HHUoH",
  fields: [
    { id: "fld0vFJUNeSuuwaRG", column: "ref" },
    { id: "fldU0k0N5b3RiqfOl", column: "template_key" },
    { id: "fld10J2UlPe3KH1gn", column: "trigger_category" },
    { id: "fldYJRG3KcI8YyQbo", column: "idempotency_key", required: true },
    { id: "fldZ1PwpI2xNXRm4I", column: "scheduled_at", convert: (v) => toDateTime(v) },
    { id: "fldBN7AFKvB77rHaV", column: "sent_at", convert: (v) => toDateTime(v) },
    { id: "fldQgZnNj0k86Wckg", column: "reply_parsed_score", convert: (v) => toInt(v) },
    { id: "fldIICnc9N59HHUoH", column: "is_test_record", convert: (v) => toBool(v) },
    // reply_text is verbatim patient text (PHI): it is mapped for Phase 6 but never logged,
    // counted by value, or written to a report.
    { id: "fld5hfgCqvHX5R8Fo", column: "reply_text" },
  ],
  links: [
    {
      kind: "record",
      fieldId: "flduUsU2TEoOlSKEK",
      label: "Patient",
      target: "acute.patients",
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
};

export const ptfWhatsappLogMapper: TableMapper = {
  key: "ptf.whatsapp_log",
  name: "PTF · Whatsapp Automation Log (history)",
  baseId: BASE.ptf,
  tableId: "tbl5wvAX6GidMm7n3",
  target: "clinical_message_log",
  status: "pending_phase6",
  naturalKey: ["ref"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldq33obO7P5my0vL", column: "ref", required: true },
    {
      id: "fldIrMo7Wv8Xi6hmx",
      column: "template_key",
      convert: (v) => slug(v).toUpperCase() || null,
    },
    { id: "fldTFQU5ZZ82B1EhC", column: "scheduled_at", convert: (v) => toDateTime(v) },
    { id: "fldneSjjHkSMEBKRw", column: "reply_text" },
  ],
  finalize(values, raw) {
    values.source = "legacy_ptf";
    values.sent = toBool(raw["fldKcsaeVetrSSDCB"]);
    values.delivered = toBool(raw["fldTvov9TmwxOdAuK"]);
    values.replied = toBool(raw["fldPrunK5pdpDIvLG"]);
  },
  links: [
    {
      kind: "record",
      fieldId: "fldT1JTjdzrcILR5H",
      label: "Patients",
      target: PATIENTS,
      column: "contact_id",
    },
  ],
};
