/**
 * The Campaigns message logs (Airtable base "Campaigns - Message Log") → Pulse.
 *
 *   Chronic Recall Messages  → recall_sends (programme chronic_90d)
 *   Birthday Messages        → recall_sends (programme birthday)
 *   Appointment Messages     → appointment_reminders (reminder history of appointments Pulse already has) and, for the
 *                              early birthday sends logged there, recall_sends (programme birthday)
 *
 * Why they matter: Make has been messaging these patients. A recall cycle (chronic: the last-visit date; birthday: the
 * year) that already has a send must block the same cycle in Pulse, and a reminder Make already sent must not be sent
 * again at cut-over. All three are create-only (staff own the rows after cut-over) and are keyed on
 * (programme, contact, cycle) or (appointment, reminder number), so a re-run never duplicates anything.
 *
 * Patients are found through the Unite patients import (the Airtable record id first, then the Unite PIN). A row whose
 * patient is not in Pulse is skipped with a reason code, never guessed. No phone number, name or message text is read;
 * the "Sent to" note is dropped.
 */
import { slug, toDate, toDateTime, toInt, toText } from "../convert";
import { unitePatientsMapper } from "../mappers/airtable.unite-patients";
import type { ImportStore } from "../store";
import { BASE } from "./bases";
import { entityOf } from "./map";
import type { TableMapper } from "./types";

const PATIENTS = "unite.patients";
const UNITE_PATIENTS_ENTITY = entityOf(unitePatientsMapper);

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The Pulse contact for a log row: the Airtable record of the Unite patient (it follows the import's own links), then
 * the Unite PIN. A contact that was merged into another is followed to the one that remains.
 */
export async function resolveLogContact(
  store: ImportStore,
  pin: string,
  uniteRecordId: string,
): Promise<string | null> {
  let id: string | null = null;
  if (uniteRecordId) {
    const ref = await store.findRef(UNITE_PATIENTS_ENTITY, uniteRecordId);
    if (ref && ref.localTable === "contacts") id = ref.localId;
  }
  if (!id && pin) {
    const hit = await store.findOne("contacts", {
      external_id: pin,
      deleted_at: null,
      merged_into_id: null,
    });
    if (hit) id = hit.id;
  }
  if (!id) return null;
  const row = await store.getRow("contacts", id);
  if (!row) return null;
  if (typeof row.merged_into_id === "string" && row.merged_into_id) return row.merged_into_id;
  return row.deleted_at ? null : id;
}

async function programmeId(store: ImportStore, key: string): Promise<string | null> {
  const p = await store.findOne("recall_programmes", { key });
  return p ? p.id : null;
}

/** Noon in Dubai (08:00 UTC): the logs hold a date, not a time, and noon is when the Make scenarios ran. */
const noonDubai = (day: string): string => `${day}T08:00:00.000Z`;

function dropHelpers(values: Row, keys: readonly string[]) {
  for (const k of keys) delete values[k];
}

// ---------------------------------------------------------------------------
// Chronic Recall Messages → recall_sends (chronic_90d)
// ---------------------------------------------------------------------------

const CHRONIC_HELPERS = ["_pin", "_unite_record_id", "_condition", "_replied", "_booked"] as const;

/** Send Status in the log: only Sent and Failed exist. Anything else is not trusted (it would read as eligible). */
function sendStatus(v: unknown, warn: (c: string) => void): string | null {
  const s = slug(v);
  if (s === "sent" || s === "failed") return s;
  if (s) warn("unknown_send_status");
  return null;
}

export const chronicRecallMapper: TableMapper = {
  key: "campaigns.chronic_recall",
  name: "Campaigns · Chronic Recall Messages",
  baseId: BASE.campaigns,
  tableId: "tbldCbNEKeF5NrTCs",
  target: "recall_sends",
  status: "ready",
  // Staff work these rows in Pulse (call list, follow-up status) after cut-over: never overwritten by a re-import.
  createOnly: true,
  naturalKey: ["programme_id", "contact_id", "cycle_key"],
  enrichedColumns: ["programme_id", "contact_id"],
  helperColumns: CHRONIC_HELPERS,
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldmqIT40DYyGAe8q", column: "_pin" },
    { id: "fldFD99GmktfyJ7Xa", column: "_unite_record_id" },
    { id: "fldvLFVogNna9clyG", column: "_condition" },
    { id: "fldzdrQ26RpvigSUE", column: "legacy_template_ref" },
    { id: "fld6a8W0nUzktk9o5", column: "last_visit_date_at_send", convert: (v) => toDate(v) },
    { id: "fldczA3OSrSQAEFE2", column: "days_since_last_visit_at_send", convert: (v) => toInt(v) },
    { id: "fld01KXt1biCwWS55", column: "sent_at", convert: (v) => toDateTime(v) },
    {
      id: "fldO6ql2L51mNEmJt",
      column: "send_mode",
      // Test sends went to internal numbers; they still count as a send for the cycle.
      convert: (v) => (slug(v) === "live" ? "live" : slug(v) === "test" ? "test" : null),
    },
    {
      id: "fldWUAkSRmbstj93Q",
      column: "status",
      required: true,
      convert: (v, warn) => sendStatus(v, warn),
    },
    { id: "fldY4zg5P4pTRFD90", column: "_replied" },
    { id: "fld1VuzlSX4IrKblI", column: "replied_at", convert: (v) => toDate(v) },
    { id: "fldJMpPFmXguYJTp0", column: "_booked" },
    { id: "fldhv2BcULV9m5k97", column: "booked_at", convert: (v) => toDate(v) },
    { id: "fldqgbYSfHGYq8LVV", column: "follow_up_status", convert: (v) => slug(v) || null },
    {
      id: "fldoG6VR5IIm5I2b5",
      column: "notes",
      convert: (v) => (/^sent to:/i.test(toText(v)) ? null : toText(v) || null),
    },
  ],
  finalize(values, _raw, warn) {
    // v_chronic_recall_eligibility dedupes on cycle_key = the last-visit date, so an imported send must carry the
    // last-visit date it was sent for, or the same patient would be messaged again in the same cycle (21B).
    // The send date is only a fallback, counted in the report.
    const lastVisit =
      typeof values.last_visit_date_at_send === "string" ? values.last_visit_date_at_send : "";
    const sent = typeof values.sent_at === "string" ? values.sent_at : "";
    if (!lastVisit) warn("cycle_key_from_sent_date");
    values.cycle_key = lastVisit || sent.slice(0, 10) || "undated";
    // follow_up_status='booked' requires booked_at (check constraint): never invent a date.
    if (values.follow_up_status === "booked" && !values.booked_at)
      values.follow_up_status = "called";
    if (text(values._replied).toLowerCase() === "yes" && !values.replied_at)
      warn("replied_without_date");
    if (text(values._booked).toLowerCase() === "yes" && !values.booked_at)
      warn("booked_without_date");
    values.source = "airtable_import";
  },
  async enrich({ values, store, warn, skip, invalid }) {
    const programme = await programmeId(store, "chronic_90d");
    if (!programme) return invalid("programme_missing");
    const contact = await resolveLogContact(
      store,
      text(values._pin),
      text(values._unite_record_id),
    );
    if (!contact) return skip("patient_not_in_pulse");
    values.programme_id = programme;
    values.contact_id = contact;
    // The template group: ref_condition_groups.name carries the same words as the log's Condition.
    const condition = text(values._condition);
    if (condition) {
      const group = await store.findOne("ref_condition_groups", { name: condition });
      values.segment_key = typeof group?.key === "string" ? group.key : null;
      if (!group) warn("unknown_condition_group");
    }
    dropHelpers(values, CHRONIC_HELPERS);
  },
};

// ---------------------------------------------------------------------------
// Birthday Messages → recall_sends (birthday)
// ---------------------------------------------------------------------------

const BIRTHDAY_HELPERS = ["_pin", "_sanoflow_id", "_sent_on", "_age"] as const;

/** Legacy rows were typed as DD/MM/YYYY into a date field: parse day-first. */
const legacyDate = (v: unknown, warn: (c: string) => void): string | null => {
  const d = toDate(v);
  if (!d && toText(v)) warn("unparseable_sent_date");
  return d;
};

async function birthdayRow(
  values: Row,
  store: ImportStore,
  invalid: (r: string) => void,
  skip: (r: string) => void,
): Promise<void> {
  const programme = await programmeId(store, "birthday");
  if (!programme) return invalid("programme_missing");
  const contact = await resolveLogContact(store, text(values._pin), "");
  if (!contact) return skip("patient_not_in_pulse");
  values.programme_id = programme;
  values.contact_id = contact;
  dropHelpers(values, BIRTHDAY_HELPERS);
}

const birthdayFinalize = (values: Row) => {
  const sentOn = typeof values._sent_on === "string" ? values._sent_on : "";
  // Birthday cycle = the year (v_birthday_today); a sent message is a sent message whatever its mode was.
  values.cycle_key = sentOn.slice(0, 4);
  values.status = "sent";
  values.send_mode = "live";
  values.sent_at = sentOn ? noonDubai(sentOn) : null;
  values.source = "airtable_import";
};

export const birthdayMapper: TableMapper = {
  key: "campaigns.birthday",
  name: "Campaigns · Birthday Messages",
  baseId: BASE.campaigns,
  tableId: "tblHTlF6LXMK5p4mU",
  target: "recall_sends",
  status: "ready",
  createOnly: true,
  naturalKey: ["programme_id", "contact_id", "cycle_key"],
  enrichedColumns: ["programme_id", "contact_id"],
  helperColumns: BIRTHDAY_HELPERS,
  dependsOn: [PATIENTS],
  fields: [
    { id: "fldUYm1BW2qck0zTm", column: "_pin" },
    { id: "fld4AGplhBuTMcFtE", column: "_sanoflow_id" },
    { id: "fldJA8wk04TfEVCAm", column: "_sent_on", required: true, convert: legacyDate },
    { id: "fld6Rlp4uzQLuJf3m", column: "_age", convert: (v) => toInt(v) },
  ],
  finalize: birthdayFinalize,
  async enrich({ values, store, invalid, skip }) {
    await birthdayRow(values, store, invalid, skip);
  },
};

// ---------------------------------------------------------------------------
// Appointment Messages → appointment_reminders (reminder history) and early birthday sends
// ---------------------------------------------------------------------------

const APPT_HELPERS = [
  "log_kind",
  "external_status",
  "clinic_licence",
  "starts_at",
  "ends_at",
  "doctor_name",
  "doctor_external_id",
  "created_by_unite_user",
  "unite_appointment_id",
  "patient_pin",
  "notes",
  "sent_on",
] as const;

/** Every field of the log the two Appointment Messages mappers read (Make wrote them; Unite is their source). */
const APPT_FIELDS = [
  { id: "fldlE1a7BlurxGn1c", column: "log_kind", convert: (v: unknown) => slug(v) || null },
  { id: "fldEjNPjzAlgKyae9", column: "external_status" },
  { id: "fldMpGtsHnKw3DP5z", column: "clinic_licence" },
  { id: "fld4B0oauTX8Q2qfN", column: "starts_at", convert: (v: unknown) => toDateTime(v) },
  { id: "fldZzUkNgSivq82JM", column: "ends_at", convert: (v: unknown) => toDateTime(v) },
  { id: "fldluFMx5NiNs8NuC", column: "doctor_name" },
  { id: "fldNHDnfMQ3bD9vA1", column: "doctor_external_id" },
  { id: "fldJHqmrkU4gHdrAr", column: "created_by_unite_user" },
  { id: "fldjRghFRS8xkpkWa", column: "unite_appointment_id" },
  { id: "fldkmbCGn5ovZIxHF", column: "patient_pin" },
  // Free-text remarks may hold clinical or personal detail: read for coverage, never written.
  { id: "fldkI33eF320eoe0F", column: "notes" },
  { id: "fld5m4VQXx6JQYAIk", column: "sent_on", convert: (v: unknown) => toDate(v) },
];

export const appointmentMessagesMapper: TableMapper = {
  key: "campaigns.appointment_messages",
  name: "Campaigns · Appointment Messages (reminder history)",
  baseId: BASE.campaigns,
  tableId: "tblhoSfiSjO4zh9cf",
  target: "appointment_reminders",
  status: "ready",
  createOnly: true,
  naturalKey: ["appointment_id", "idx"],
  enrichedColumns: ["appointment_id"],
  helperColumns: APPT_HELPERS,
  dependsOn: [PATIENTS],
  fields: APPT_FIELDS,
  finalize(values) {
    // The log holds only a date; the send time is unknown → noon Dubai (08:00 UTC).
    values.sent_at = typeof values.sent_on === "string" ? noonDubai(values.sent_on) : null;
    values.due_at = values.sent_at;
    values.idx = 1;
    values.status = "sent";
  },
  skip(values) {
    // Early birthday sends were logged here before the Birthday table existed: the second mapper takes those.
    if (values.log_kind === "birthday") return "birthday_row_handled_by_birthday_log_mapper";
    if (!values.sent_at) return "reminder_not_sent";
    return null;
  },
  async enrich({ values, store, skip }) {
    // Appointments come from the Unite sync (source 'unite', keyed on Unite's appointment id). This only records that
    // Make already reminded the patient about one Pulse has; it never creates an appointment.
    const externalId = text(values.unite_appointment_id);
    if (!externalId) return skip("no_appointment_id");
    const appt = await store.findOne("appointments", { source: "unite", external_id: externalId });
    if (!appt) return skip("appointment_not_in_pulse");
    values.appointment_id = appt.id;
    dropHelpers(values, APPT_HELPERS);
  },
};

export const appointmentLogBirthdayMapper: TableMapper = {
  key: "campaigns.appointment_messages_birthday",
  name: "Campaigns · Appointment Messages (early birthday sends)",
  baseId: BASE.campaigns,
  tableId: "tblhoSfiSjO4zh9cf",
  entitySuffix: "birthday_log",
  target: "recall_sends",
  status: "ready",
  createOnly: true,
  naturalKey: ["programme_id", "contact_id", "cycle_key"],
  enrichedColumns: ["programme_id", "contact_id"],
  helperColumns: [...APPT_HELPERS, ...BIRTHDAY_HELPERS],
  dependsOn: [PATIENTS],
  fields: APPT_FIELDS,
  finalize(values) {
    values._sent_on = typeof values.sent_on === "string" ? values.sent_on : "";
    values._pin = text(values.patient_pin);
    birthdayFinalize(values);
  },
  skip(values) {
    if (values.log_kind !== "birthday") return "not_a_birthday_row";
    if (!values._sent_on) return "birthday_without_send_date";
    return null;
  },
  async enrich({ values, store, invalid, skip }) {
    await birthdayRow(values, store, invalid, skip);
    dropHelpers(values, APPT_HELPERS);
  },
};
