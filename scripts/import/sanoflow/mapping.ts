/**
 * Sanoflow export headers → importer fields, one table per export. Sanoflow column names live ONLY
 * in this file (the contact export keeps its own in ../mappers/sanoflow.contacts.ts). Header names
 * vary between Sanoflow versions and per-pipeline exports, so every field has several aliases and
 * the whole mapping can be overridden with a JSON file ({ "CSV header": "field" | null }).
 *
 * Unknown columns are never read: they are listed by header name in the report and ignored.
 * Aliases come from the export screens and the form field names in docs/audit/sanoflow-surface.json;
 * they describe Sanoflow's columns, they are not reused as Pulse names (CLAUDE.md rule 14).
 */

export const SANOFLOW_EXPORTS = [
  "enquiry",
  "enquiry_activity",
  "appointment",
  "tag",
  "label",
  "conv_category",
  "quick_reply",
  "segment_member",
  "segment_dynamic",
  "campaign_recipient",
] as const;
export type SanoflowExport = (typeof SANOFLOW_EXPORTS)[number];

/** Lower-case, punctuation and repeated spaces collapsed: "Enquiry_ID " → "enquiry id". */
export const normHeader = (h: string) =>
  h
    .replace(/^﻿/, "")
    .trim()
    .toLowerCase()
    .replace(/[_*#:.\-/()]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

type AliasTable = Record<string, readonly string[]>;

const ENQUIRY: AliasTable = {
  id: ["enquiry id", "enquiryid", "id", "lead id", "leadid", "enquiry no", "enquiry number"],
  contact_id: ["contact id", "contactid", "patient id", "patientid"],
  phone: [
    "phone",
    "phone number",
    "mobile",
    "full phone",
    "fullphone",
    "fullphonenumber",
    "whatsapp",
  ],
  pipeline: ["pipeline", "pipeline name"],
  stage: ["stage", "enquiry stage", "stage name"],
  status: ["status", "enquiry status"],
  lost_reason: [
    "disqualify reason",
    "disqualified reason",
    "lost reason",
    "reason",
    "close reason",
  ],
  title: ["title", "enquiry title", "subject"],
  value: ["value", "estimated value", "est value", "amount", "deal value"],
  source: ["source", "enquiry source", "lead source"],
  channel_name: ["enquiry channel", "channel"],
  assignee_email: [
    "assignee email",
    "assigned to email",
    "owner email",
    "user email",
    "agent email",
  ],
  location: ["location", "branch", "clinic"],
  specialist: ["specialist", "doctor", "practitioner"],
  service: ["service", "treatment"],
  appt_date: ["appointment date", "appt date", "appointmentdate"],
  appt_time: ["appointment time", "appt time", "appointmenttime"],
  created_at: ["created at", "created on", "created date", "open date", "date created", "created"],
  closed_at: ["closed at", "closed on", "close date", "closed date"],
  tags: ["tags", "tag", "enquiry tags", "enquiry tag"],
  utm_source: ["utm source"],
  utm_medium: ["utm medium"],
  utm_campaign: ["utm campaign"],
  utm_content: ["utm content"],
  utm_term: ["utm term"],
};

const ACTIVITY: AliasTable = {
  id: ["activity id", "activityid", "log id"],
  enquiry_id: ["enquiry id", "enquiryid", "lead id", "leadid", "enquiry no", "enquiry number"],
  kind: ["activity", "activity type", "type", "action", "event"],
  text: ["description", "details", "note", "notes", "comment", "message"],
  by: ["user", "done by", "performed by", "by", "updated by", "created by"],
  at: ["date", "date time", "datetime", "created at", "activity date", "time", "timestamp"],
};

const APPOINTMENT: AliasTable = {
  id: ["appointment id", "appointmentid", "appt id", "apptid", "id", "booking id"],
  contact_id: ["contact id", "contactid", "patient id", "patientid"],
  phone: ["phone", "phone number", "mobile", "full phone", "fullphone", "whatsapp"],
  location: ["location", "branch", "clinic", "location name"],
  specialist: ["specialist", "doctor", "practitioner", "specialist name"],
  service: ["service", "treatment", "service name"],
  date: ["date", "appointment date", "appt date", "apptdate"],
  start: ["start time", "starttime", "time", "from", "start", "appointment time"],
  end: ["end time", "endtime", "to", "end"],
  duration: ["duration", "duration min", "duration minutes"],
  status: ["status", "appointment status"],
  notes: ["notes", "note", "comments"],
};

const LIST: AliasTable = {
  id: ["id", "tag id", "label id", "category id"],
  name: ["name", "tag", "tag name", "label", "label name", "category", "category name", "title"],
  color: ["color", "colour"],
};

const QUICK_REPLY: AliasTable = {
  id: ["id", "message template id", "messagetemplateid", "canned message id"],
  shortcut: ["shortcut", "short code", "shortcode", "keyword"],
  name: ["name", "title", "template name"],
  text: ["message", "text", "body", "content", "message english", "english"],
  text_ar: ["message arabic", "arabic", "text ar", "arabic message"],
};

const SEGMENT_MEMBER: AliasTable = {
  segment_id: ["segment id", "segmentid"],
  segment: ["segment", "segment name", "segmentname"],
  contact_id: ["contact id", "contactid", "patient id", "patientid"],
  phone: ["phone", "phone number", "mobile", "full phone", "fullphone", "whatsapp"],
};

const SEGMENT_DYNAMIC: AliasTable = {
  segment: ["segment", "segment name", "name"],
  filter: ["filter", "segment filter", "conditions", "rules"],
};

const CAMPAIGN_RECIPIENT: AliasTable = {
  campaign_id: ["campaign id", "campaignid", "campaign schedule id", "scheduled id"],
  campaign: ["campaign", "campaign name", "campaignname"],
  template: ["template", "template name", "templatename"],
  contact_id: ["contact id", "contactid", "patient id", "patientid"],
  phone: ["phone", "phone number", "mobile", "full phone", "fullphone", "whatsapp", "recipient"],
  status: ["status", "message status", "delivery status"],
  sent_at: ["sent at", "sent on", "sent", "sent time", "date"],
  delivered_at: ["delivered at", "delivered on", "delivered time"],
  read_at: ["read at", "read on", "read time", "seen at"],
  replied_at: ["replied at", "replied on", "reply time", "responded at"],
  failed_at: ["failed at", "failed on"],
  error_code: ["error code", "errorcode", "failure code"],
};

export const SANOFLOW_ALIASES: Record<SanoflowExport, AliasTable> = {
  enquiry: ENQUIRY,
  enquiry_activity: ACTIVITY,
  appointment: APPOINTMENT,
  tag: LIST,
  label: LIST,
  conv_category: LIST,
  quick_reply: QUICK_REPLY,
  segment_member: SEGMENT_MEMBER,
  segment_dynamic: SEGMENT_DYNAMIC,
  campaign_recipient: CAMPAIGN_RECIPIENT,
};

/** Fields each export cannot be imported without. */
export const REQUIRED_FIELDS: Record<SanoflowExport, readonly string[][]> = {
  enquiry: [["id"], ["pipeline"], ["stage"]],
  enquiry_activity: [["enquiry_id"], ["at"]],
  appointment: [["id"], ["contact_id", "phone"], ["specialist"], ["location"], ["date", "start"]],
  tag: [["name"]],
  label: [["name"]],
  conv_category: [["name"]],
  quick_reply: [["text"], ["shortcut", "name"]],
  // the segment may come from the file name ("segment-<name>.csv"); it is checked per row
  segment_member: [["contact_id", "phone"]],
  segment_dynamic: [["segment"]],
  // the campaign may come from the file name ("campaign-report-<name>.csv")
  campaign_recipient: [["contact_id", "phone"], ["status"]],
};

export type HeaderMapping = {
  /** CSV header → importer field ("custom.<key>" for an enquiry custom field), or null when ignored. */
  mapping: Record<string, string | null>;
  /** importer field → column index */
  index: Record<string, number>;
  /** Headers that matched nothing and are ignored. */
  unknown: string[];
  /** Required field groups with no column ("contact_id|phone"). */
  missing: string[];
};

/**
 * Maps headers for one export. Earlier aliases win; a field is taken by the first header that
 * matches it. Enquiry exports also match enquiry custom fields by key or label.
 */
export function mapHeaders(
  kind: SanoflowExport,
  headers: string[],
  opts: {
    override?: Record<string, string | null>;
    customFields?: ReadonlyArray<{ key: string; label: string }>;
  } = {},
): HeaderMapping {
  const aliases = SANOFLOW_ALIASES[kind];
  const mapping: Record<string, string | null> = {};
  const index: Record<string, number> = {};
  const take = (h: string, i: number, field: string | null) => {
    if (field && field in index) field = null;
    mapping[h] = field;
    if (field) index[field] = i;
  };

  if (opts.override) {
    headers.forEach((h, i) => {
      if (h in opts.override!) take(h, i, opts.override![h]);
    });
  }
  // Pass 1: alias position decides priority across headers ("enquiry id" beats a bare "id").
  const byField = Object.entries(aliases);
  for (const [field, names] of byField) {
    if (field in index) continue;
    for (const name of names) {
      const i = headers.findIndex((h) => !(h in mapping) && normHeader(h) === name);
      if (i >= 0) {
        take(headers[i], i, field);
        break;
      }
    }
  }
  if (kind === "enquiry" && opts.customFields?.length) {
    headers.forEach((h, i) => {
      if (h in mapping) return;
      const n = normHeader(h);
      const def = opts.customFields!.find(
        (d) => normHeader(d.key) === n || normHeader(d.label) === n,
      );
      if (def) take(h, i, `custom.${def.key}`);
    });
  }
  const unknown: string[] = [];
  for (const h of headers) {
    if (!(h in mapping)) {
      mapping[h] = null;
      if (h.trim()) unknown.push(h);
    }
  }
  const missing = REQUIRED_FIELDS[kind]
    .filter((group) => !group.some((f) => f in index))
    .map((group) => group.join("|"));
  return { mapping, index, unknown, missing };
}

/** Reads one mapped field from a CSV row: trimmed, "" when the column is absent. */
export function cell(row: readonly string[], index: Record<string, number>, field: string): string {
  const i = index[field];
  return i === undefined ? "" : (row[i] ?? "").trim();
}
