/** Campaign logs and staff lists whose targets (recall, appointments, specialists) arrive in Phase 6. */
import { slug, toBool, toDate, toDateTime, toInt, toText } from "../convert";
import { BASE } from "./bases";
import type { TableMapper } from "./types";

const PATIENTS = "unite.patients";

export const chronicRecallMapper: TableMapper = {
  key: "campaigns.chronic_recall",
  name: "Campaigns · Chronic Recall Messages",
  baseId: BASE.campaigns,
  tableId: "tbldCbNEKeF5NrTCs",
  target: "recall_sends",
  status: "pending_phase6",
  naturalKey: ["programme_key", "patient_pin", "cycle_key"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldmqIT40DYyGAe8q", column: "patient_pin", required: true },
    { id: "fldFD99GmktfyJ7Xa", column: "unite_record_id" },
    { id: "fldvLFVogNna9clyG", column: "segment_key", convert: (v) => slug(v) || null },
    { id: "fldzdrQ26RpvigSUE", column: "legacy_template_ref" },
    { id: "fld6a8W0nUzktk9o5", column: "last_visit_date_at_send", convert: (v) => toDate(v) },
    { id: "fldczA3OSrSQAEFE2", column: "days_since_last_visit_at_send", convert: (v) => toInt(v) },
    { id: "fld01KXt1biCwWS55", column: "sent_at", convert: (v) => toDateTime(v) },
    { id: "fldO6ql2L51mNEmJt", column: "send_mode", convert: (v) => slug(v) || null },
    { id: "fldWUAkSRmbstj93Q", column: "status", convert: (v) => slug(v) || null },
    { id: "fld1VuzlSX4IrKblI", column: "replied_at", convert: (v) => toDate(v) },
    { id: "fldhv2BcULV9m5k97", column: "booked_at", convert: (v) => toDate(v) },
    { id: "fldqgbYSfHGYq8LVV", column: "follow_up_status", convert: (v) => slug(v) || null },
    {
      id: "fldoG6VR5IIm5I2b5",
      column: "notes",
      convert: (v) => (/^sent to:/i.test(toText(v)) ? null : toText(v) || null),
    },
  ],
  finalize(values) {
    values.programme_key = "chronic_90d";
    const sent = typeof values.sent_at === "string" ? values.sent_at : "";
    values.cycle_key = sent.slice(0, 10) || "undated";
    // follow_up_status='booked' requires booked_at (check constraint): never invent a date.
    if (values.follow_up_status === "booked" && !values.booked_at)
      values.follow_up_status = "called";
  },
};

export const birthdayMapper: TableMapper = {
  key: "campaigns.birthday",
  name: "Campaigns · Birthday Messages",
  baseId: BASE.campaigns,
  tableId: "tblHTlF6LXMK5p4mU",
  target: "recall_sends",
  status: "pending_phase6",
  naturalKey: ["programme_key", "patient_pin", "cycle_key"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldUYm1BW2qck0zTm", column: "patient_pin" },
    { id: "fld4AGplhBuTMcFtE", column: "sanoflow_patient_id" },
    // legacy rows were typed as DD/MM/YYYY into a date field: parse day-first
    {
      id: "fldJA8wk04TfEVCAm",
      column: "sent_on",
      convert: (v, warn) => {
        const d = toDate(v);
        if (!d && toText(v)) warn("unparseable_sent_date");
        return d;
      },
    },
    { id: "fld6Rlp4uzQLuJf3m", column: "age_at_send", convert: (v) => toInt(v) },
  ],
  finalize(values) {
    values.programme_key = "birthday";
    values.cycle_key = typeof values.sent_on === "string" ? values.sent_on.slice(0, 4) : "unknown";
    if (!values.patient_pin && !values.sanoflow_patient_id) values.patient_pin = null;
  },
};

export const appointmentMessagesMapper: TableMapper = {
  key: "campaigns.appointment_messages",
  name: "Campaigns · Appointment Messages",
  baseId: BASE.campaigns,
  tableId: "tblhoSfiSjO4zh9cf",
  target: "appointment_reminders",
  status: "pending_phase6",
  naturalKey: ["unite_appointment_id"],
  dependsOn: [PATIENTS, "ptf.doctors"],
  fields: [
    { id: "fldlE1a7BlurxGn1c", column: "log_kind", convert: (v) => slug(v) || null },
    { id: "fldEjNPjzAlgKyae9", column: "external_status" },
    { id: "fldMpGtsHnKw3DP5z", column: "clinic_licence" },
    { id: "fld4B0oauTX8Q2qfN", column: "starts_at", convert: (v) => toDateTime(v) },
    { id: "fldZzUkNgSivq82JM", column: "ends_at", convert: (v) => toDateTime(v) },
    { id: "fldluFMx5NiNs8NuC", column: "doctor_name" },
    { id: "fldNHDnfMQ3bD9vA1", column: "doctor_external_id" },
    { id: "fldJHqmrkU4gHdrAr", column: "created_by_unite_user" },
    { id: "fldjRghFRS8xkpkWa", column: "unite_appointment_id" },
    { id: "fldkmbCGn5ovZIxHF", column: "patient_pin" },
    { id: "fldkI33eF320eoe0F", column: "notes" },
    { id: "fld5m4VQXx6JQYAIk", column: "sent_on", convert: (v) => toDate(v) },
  ],
  finalize(values) {
    // The log holds only a date; the send time is unknown → noon Asia/Dubai (08:00 UTC).
    values.sent_at = typeof values.sent_on === "string" ? `${values.sent_on}T08:00:00.000Z` : null;
    // Early birthday sends were logged here before the Birthday table existed.
    values.target_override = values.log_kind === "birthday" ? "recall_sends" : null;
  },
};

export const doctorsMapper: TableMapper = {
  key: "ptf.doctors",
  name: "PTF · Doctors",
  baseId: BASE.ptf,
  tableId: "tblhoMqQ1jgiCGHGY",
  target: "specialists",
  status: "pending_phase6",
  naturalKey: ["name"],
  fields: [
    { id: "fld0ghl5SVDzYlwU0", column: "name", required: true },
    { id: "fldkfam3qESHnrbTr", column: "specialty" },
    { id: "fld4QdPKVRNqVlRKk", column: "branch" },
  ],
};

export const messageTemplatesMapper: TableMapper = {
  key: "acute.message_templates",
  name: "Acute · Message Templates",
  baseId: BASE.acute,
  tableId: "tblnCsSkyw4Tu9Ak7",
  target: "wa_templates",
  status: "pending_phase6",
  naturalKey: ["internal_key"],
  fields: [
    { id: "fldgpCwM1uG424pKz", column: "internal_key", required: true },
    { id: "fldtnpNhYCdu8Sdbr", column: "purpose" },
    { id: "fldVafqyE1Co6QOqR", column: "trigger_note" },
    { id: "fldCipfcyRejaEmu2", column: "expects_reply", convert: (v) => slug(v) || null },
    { id: "fldyfsVBI5CP4L8GM", column: "draft_copy" },
    { id: "fld1lj7DaZSAaJRME", column: "clinical_approval", convert: (v) => slug(v) || "awaiting" },
    { id: "fldruCMCoDqzTEtgH", column: "clinical_phase", convert: (v) => toInt(v) },
    { id: "fldxEiS8klZNiMZWC", column: "sanoflow_template_id" },
    { id: "fldHKolWfL6RVnBHQ", column: "clinical_notes" },
  ],
  // FU_* entries are call scripts, not WhatsApp templates (they go to clinical_call_scripts).
  finalize(values) {
    values.target_override = String(values.internal_key ?? "").startsWith("FU_")
      ? "clinical_call_scripts"
      : null;
  },
};

export const ptfPatientVisitsMapper: TableMapper = {
  key: "ptf.patient_visits",
  name: "PTF · Patient Visits (backlog: visit feedback)",
  baseId: BASE.ptf,
  tableId: "tbldH45nIL5EQAjpy",
  target: "visit_feedback",
  status: "pending_phase6",
  naturalKey: ["external_id"],
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldxdC4oFODCEejLD", column: "external_id", required: true },
    { id: "fld7GVu2ybazYOv03", column: "visit_date", convert: (v) => toDate(v) },
    { id: "fldAeSKvv54kqEjkA", column: "visit_status", convert: (v) => slug(v) || null },
    { id: "fld62vpgB5VCR8hDE", column: "status", convert: (v) => slug(v) || null },
    { id: "fldRksUIiqT14u49f", column: "rating", convert: (v) => toInt(v) },
    { id: "fldbcDnJjDVZo7d9s", column: "comment" },
    { id: "fldbOBEWZuN8entnV", column: "submitted_at", convert: (v) => toDateTime(v) },
    { id: "fld8ecrYgvB47rZXY", column: "low_rating_alert_sent", convert: (v) => toBool(v) },
  ],
  links: [
    {
      kind: "record",
      fieldId: "fldXTGoEy5kkTw5Uu",
      label: "Patient",
      target: PATIENTS,
      column: "contact_id",
    },
  ],
};
