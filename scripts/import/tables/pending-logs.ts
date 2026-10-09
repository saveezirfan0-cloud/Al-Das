/**
 * Campaign logs still validated by --dry-run only. Each says why it is not written yet.
 * (Doctors, call scripts and the clinical tables moved to tables/clinical.ts.)
 */
import { slug, toDate, toDateTime, toInt, toText } from "../convert";
import { BASE } from "./bases";
import type { TableMapper } from "./types";

const PATIENTS = "unite.patients";

export const chronicRecallMapper: TableMapper = {
  key: "campaigns.chronic_recall",
  name: "Campaigns · Chronic Recall Messages",
  baseId: BASE.campaigns,
  tableId: "tbldCbNEKeF5NrTCs",
  target: "recall_sends",
  status: "pending",
  pendingReason:
    "recall_sends exists (Phase 8) but this mapper still uses draft column names (programme_key, patient_pin); it needs rewriting against recall_programmes/recall_sends and contact lookup by PIN.",
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
  status: "pending",
  pendingReason:
    "recall_sends exists (Phase 8) but this mapper still uses draft column names; it needs rewriting against recall_programmes/recall_sends and contact lookup by PIN.",
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
  status: "pending",
  pendingReason:
    "Needs an appointments + appointment_reminders writer (past appointments only, status 'sent', no message id) and the Unite status-code meanings (OQ-23); see docs/06_PHASE_9_NOTES.md.",
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
