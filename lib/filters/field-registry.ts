/**
 * Field registry: the only place that maps filter field keys to SQL columns,
 * jsonb custom-field keys and related tables. The compiler never trusts a
 * key from the AST that is not registered here, which is what keeps the
 * dynamic SQL safe.
 */
import { AGE_BAND_LABELS, AGE_BANDS } from "@/lib/contacts/age-band";
import { LIFECYCLE_LABELS, LIFECYCLE_STAGES } from "@/lib/contacts/lifecycle";
import { DAYS_OPERATORS, LIST_OPERATORS, UNARY_OPERATORS, type Operator } from "@/lib/filters/ast";

export type FieldType =
  | "text"
  | "number"
  | "date"
  | "datetime"
  | "boolean"
  | "select"
  | "multi_select"
  | "user"
  | "set" // relation membership (tags, segments)
  | "anniversary"
  | "count";

export type SqlType = "text" | "uuid" | "numeric" | "integer" | "date" | "timestamptz" | "boolean";

export type RelationKey =
  | "contact_tags"
  | "segment_members"
  | "contact_phones"
  | "mentions"
  | "conversations"
  | "enquiries"
  | "appointments"
  | "campaign_recipients"
  | "tasks"
  | "enquiry_tags"
  // Track P (docs/45 P4/P5): one-row-per-contact views and visit/diagnosis views. All are security_invoker views.
  | "contact_lifecycle"
  | "contact_age_band"
  | "contact_visit_stats"
  | "contact_visit_segments"
  | "contact_chronic_groups"
  | "contact_visit_groups";

export type RelationDef = {
  key: RelationKey;
  /** Schema-qualified table name. */
  table: string;
  /** Column on the related table pointing at contacts.id. */
  contactColumn: string;
  /** Column types for the related columns referenced by fields. */
  columns: Record<string, SqlType>;
  /** Extra predicate on the related row (e.g. soft deletes). */
  extraWhere?: string;
};

export type FieldSource =
  | { kind: "column"; column: string; sqlType: SqlType }
  | { kind: "custom"; key: string }
  | { kind: "relation"; relation: RelationKey; column: string }
  | { kind: "count"; relation: RelationKey };

export type FieldOption = { value: string; label: string };

export type FieldDef = {
  key: string;
  label: string;
  group: string;
  type: FieldType;
  source: FieldSource;
  /** Static options for select fields. */
  options?: FieldOption[];
  /** Options resolved by the UI (users, tags, segments, …). */
  optionsSource?:
    | "users"
    | "tags"
    | "segments"
    | "channels"
    | "stages"
    | "locations"
    | "specialists"
    | "services"
    | "departments"
    | "pipelines"
    | "sources"
    | "condition_groups";
  /** Hidden from the UI (and rejected by the compiler) until the relation exists. */
  available: boolean;
  /** Can be used in ORDER BY (column / custom / count only). */
  sortable: boolean;
  /**
   * Derived from visits, diagnoses, doctors, departments or visit dates (health data). A filter that uses a clinical
   * field may build care audiences (recall, follow-up) but never a marketing audience: lib/campaigns/audience-purpose.ts.
   * Custom fields are not clinical by default (an org-defined field cannot be classified here).
   */
  clinical: boolean;
};

export type FieldRegistry = {
  fields: ReadonlyMap<string, FieldDef>;
  relations: Readonly<Record<RelationKey, RelationDef>>;
  list(): FieldDef[];
  get(key: string): FieldDef | undefined;
  require(key: string): FieldDef;
};

export class UnknownFieldError extends Error {
  constructor(public readonly field: string) {
    super(`Unknown or unavailable filter field: ${field}`);
    this.name = "UnknownFieldError";
  }
}

export class InvalidOperatorError extends Error {
  constructor(
    public readonly field: string,
    public readonly op: Operator,
  ) {
    super(`Operator ${op} is not valid for field ${field}`);
    this.name = "InvalidOperatorError";
  }
}

/** Which operators each field type accepts. */
export const OPERATORS_BY_TYPE: Record<FieldType, readonly Operator[]> = {
  text: [
    "eq",
    "neq",
    "contains",
    "not_contains",
    "starts_with",
    "ends_with",
    "in",
    "not_in",
    "is_empty",
    "is_not_empty",
  ],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "is_empty", "is_not_empty"],
  count: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  date: [
    "on",
    "before",
    "after",
    "between",
    "within_last",
    "not_within_last",
    "older_than",
    "within_next",
    "is_empty",
    "is_not_empty",
  ],
  datetime: [
    "on",
    "before",
    "after",
    "between",
    "within_last",
    "not_within_last",
    "older_than",
    "within_next",
    "is_empty",
    "is_not_empty",
  ],
  boolean: ["is_true", "is_false"],
  select: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  user: ["eq", "neq", "in", "not_in", "is_empty", "is_not_empty"],
  multi_select: ["has_any", "has_all", "has_none", "is_empty", "is_not_empty"],
  set: ["has_any", "has_all", "has_none", "is_empty", "is_not_empty"],
  anniversary: ["is_today", "within_next", "month_is", "is_empty", "is_not_empty"],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  eq: "is",
  neq: "is not",
  contains: "contains",
  not_contains: "does not contain",
  starts_with: "starts with",
  ends_with: "ends with",
  in: "is any of",
  not_in: "is none of",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  between: "between",
  on: "is on",
  before: "is before",
  after: "is after",
  within_last: "within the last (days)",
  not_within_last: "not within the last (days)",
  older_than: "more than (days) ago",
  within_next: "within the next (days)",
  is_true: "is yes",
  is_false: "is no",
  has_any: "has any of",
  has_all: "has all of",
  has_none: "has none of",
  is_today: "is today",
  month_is: "month is",
};

export function operatorIsUnary(op: Operator): boolean {
  return UNARY_OPERATORS.has(op);
}
export function operatorTakesList(op: Operator): boolean {
  return LIST_OPERATORS.has(op);
}
export function operatorTakesDays(op: Operator): boolean {
  return DAYS_OPERATORS.has(op);
}

export function operatorAllowed(field: FieldDef, op: Operator): boolean {
  return OPERATORS_BY_TYPE[field.type].includes(op);
}

export const CONTACT_RELATIONS: Record<RelationKey, RelationDef> = {
  contact_tags: {
    key: "contact_tags",
    table: "public.contact_tags",
    contactColumn: "contact_id",
    columns: { tag_id: "uuid" },
  },
  segment_members: {
    key: "segment_members",
    table: "public.segment_members",
    contactColumn: "contact_id",
    columns: { segment_id: "uuid" },
  },
  contact_phones: {
    key: "contact_phones",
    table: "public.contact_phones",
    contactColumn: "contact_id",
    columns: { phone_e164: "text" },
  },
  mentions: {
    key: "mentions",
    table: "public.mentions",
    contactColumn: "contact_id",
    columns: { user_id: "uuid", read_at: "timestamptz" },
  },
  // Phase 3+ relations. Registered now so saved filters validate; marked
  // unavailable until the tables exist (see buildContactFieldRegistry).
  conversations: {
    key: "conversations",
    table: "public.conversations",
    contactColumn: "contact_id",
    columns: {
      status: "text",
      channel_id: "uuid",
      last_message_at: "timestamptz",
      ai_tags: "text",
    },
  },
  enquiries: {
    key: "enquiries",
    table: "public.enquiries",
    contactColumn: "contact_id",
    columns: {
      stage_id: "uuid",
      status: "text",
      lost_reason: "text",
      est_value: "numeric",
      created_at: "timestamptz",
      closed_at: "timestamptz",
      created_by: "uuid",
      channel_id: "uuid",
      location_id: "uuid",
      specialist_id: "uuid",
      service_id: "uuid",
      source: "text",
    },
    extraWhere: "r.deleted_at is null",
  },
  appointments: {
    key: "appointments",
    table: "public.appointments",
    contactColumn: "contact_id",
    columns: {
      starts_at: "timestamptz",
      status: "text",
      location_id: "uuid",
      specialist_id: "uuid",
      service_id: "uuid",
      department_id: "uuid",
      created_at: "timestamptz",
      created_by: "uuid",
      notify_early: "boolean",
      notes: "text",
    },
  },
  // Enquiry-only (Phase 20a): the enquiry registry joins it on enquiry_id. No contact field uses it and it
  // is not in AVAILABLE_RELATIONS, so it can never reach a contact query.
  enquiry_tags: {
    key: "enquiry_tags",
    table: "public.enquiry_tags",
    contactColumn: "enquiry_id",
    columns: { tag_id: "uuid" },
  },
  campaign_recipients: {
    key: "campaign_recipients",
    table: "public.campaign_recipients",
    contactColumn: "contact_id",
    columns: { campaign_id: "uuid", status: "text" },
  },
  tasks: {
    key: "tasks",
    table: "public.tasks",
    contactColumn: "contact_id",
    columns: { due_at: "timestamptz", done: "boolean" },
    extraWhere: "r.done = false and r.deleted_at is null",
  },
  // Track P views (migration 20261220000200). Lifecycle and age band have exactly one row per contact.
  contact_lifecycle: {
    key: "contact_lifecycle",
    table: "public.v_contact_lifecycle",
    contactColumn: "contact_id",
    columns: { stage: "text" },
  },
  contact_age_band: {
    key: "contact_age_band",
    table: "public.v_contact_age_band",
    contactColumn: "contact_id",
    columns: { age_band: "text" },
  },
  // One row for a contact with any known visit date (Pulse visits or Unite's patient date); none otherwise.
  contact_visit_stats: {
    key: "contact_visit_stats",
    table: "public.v_contact_visit_stats",
    contactColumn: "contact_id",
    columns: { last_visit_date: "date" },
  },
  contact_visit_segments: {
    key: "contact_visit_segments",
    table: "public.v_contact_visit_segments",
    contactColumn: "contact_id",
    columns: { specialist_id: "uuid", department: "text", visit_date: "date" },
  },
  contact_chronic_groups: {
    key: "contact_chronic_groups",
    table: "public.v_contact_diagnosis_groups",
    contactColumn: "contact_id",
    columns: { condition_group_id: "uuid" },
    extraWhere: "r.source = 'chronic'",
  },
  contact_visit_groups: {
    key: "contact_visit_groups",
    table: "public.v_contact_diagnosis_groups",
    contactColumn: "contact_id",
    columns: { condition_group_id: "uuid" },
    extraWhere: "r.source = 'visit'",
  },
};

/** Relations whose tables exist today. Later phases extend this list. */
export const AVAILABLE_RELATIONS: readonly RelationKey[] = [
  "contact_tags",
  "segment_members",
  "contact_phones",
  "mentions",
  "appointments",
  "enquiries",
  "tasks",
  "contact_lifecycle",
  "contact_age_band",
  "contact_visit_stats",
  "contact_visit_segments",
  "contact_chronic_groups",
  "contact_visit_groups",
];

export type CustomFieldDefInput = {
  key: string;
  label: string;
  type:
    "text" | "number" | "date" | "boolean" | "select" | "multi_select" | "url" | "email" | "phone";
  options?: Array<{ value: string; label: string }> | null;
};

const col = (column: string, sqlType: SqlType): FieldSource => ({
  kind: "column",
  column,
  sqlType,
});
const rel = (relation: RelationKey, column: string): FieldSource => ({
  kind: "relation",
  relation,
  column,
});

type Partial = Omit<FieldDef, "available" | "sortable" | "clinical"> & {
  sortable?: boolean;
  clinical?: boolean;
};

const CONTACT_BASE_FIELDS: Partial[] = [
  // Contact
  {
    key: "full_name",
    label: "Name",
    group: "Contact",
    type: "text",
    source: col("full_name", "text"),
    sortable: true,
  },
  {
    key: "first_name",
    label: "First name",
    group: "Contact",
    type: "text",
    source: col("first_name", "text"),
    sortable: true,
  },
  {
    key: "last_name",
    label: "Last name",
    group: "Contact",
    type: "text",
    source: col("last_name", "text"),
    sortable: true,
  },
  {
    key: "gender",
    label: "Gender",
    group: "Contact",
    type: "select",
    source: col("gender", "text"),
    options: [
      { value: "female", label: "Female" },
      { value: "male", label: "Male" },
      { value: "other", label: "Other" },
      { value: "unknown", label: "Unknown" },
    ],
    sortable: true,
  },
  {
    key: "nationality",
    label: "Nationality",
    group: "Contact",
    type: "text",
    source: col("nationality", "text"),
    sortable: true,
  },
  {
    key: "tags",
    label: "Tags",
    group: "Contact",
    type: "set",
    source: rel("contact_tags", "tag_id"),
    optionsSource: "tags",
  },
  {
    key: "segments",
    label: "Segments",
    group: "Contact",
    type: "set",
    source: rel("segment_members", "segment_id"),
    optionsSource: "segments",
  },
  {
    key: "country",
    label: "Country",
    group: "Contact",
    type: "text",
    source: col("country", "text"),
    sortable: true,
  },
  {
    key: "phone",
    label: "Phone",
    group: "Contact",
    type: "text",
    source: col("phone_e164", "text"),
    sortable: true,
  },
  {
    key: "alternate_phone",
    label: "Alternate phone",
    group: "Contact",
    type: "text",
    source: rel("contact_phones", "phone_e164"),
  },
  {
    key: "email",
    label: "Email",
    group: "Contact",
    type: "text",
    source: col("email", "text"),
    sortable: true,
  },
  {
    key: "dob",
    label: "Date of birth",
    group: "Contact",
    type: "date",
    source: col("dob", "date"),
    sortable: true,
  },
  {
    key: "birthday",
    label: "Birthday",
    group: "Contact",
    type: "anniversary",
    source: col("dob", "date"),
  },
  {
    key: "language",
    label: "Language",
    group: "Contact",
    type: "text",
    source: col("language", "text"),
    sortable: true,
  },
  {
    key: "label",
    label: "Label",
    group: "Contact",
    type: "text",
    source: col("label", "text"),
    sortable: true,
  },
  {
    key: "created_at",
    label: "Created date",
    group: "Contact",
    type: "datetime",
    source: col("created_at", "timestamptz"),
    sortable: true,
  },
  {
    key: "updated_at",
    label: "Updated date",
    group: "Contact",
    type: "datetime",
    source: col("updated_at", "timestamptz"),
    sortable: true,
  },
  {
    key: "created_by",
    label: "Created by",
    group: "Contact",
    type: "user",
    source: col("created_by", "uuid"),
    optionsSource: "users",
  },
  {
    key: "owner",
    label: "Contact owner",
    group: "Contact",
    type: "user",
    source: col("owner_id", "uuid"),
    optionsSource: "users",
  },
  {
    key: "assignee",
    label: "Assignee",
    group: "Contact",
    type: "user",
    source: col("assignee_id", "uuid"),
    optionsSource: "users",
  },
  {
    key: "home_branch",
    label: "Home branch",
    group: "Contact",
    type: "select",
    source: col("location_id", "uuid"),
    optionsSource: "locations",
  },
  {
    key: "external_id",
    label: "External ID (Unite PIN)",
    group: "Contact",
    type: "text",
    source: col("external_id", "text"),
    sortable: true,
  },
  {
    key: "stop_marketing",
    label: "Stop marketing",
    group: "Contact",
    type: "boolean",
    source: col("stop_marketing", "boolean"),
    sortable: true,
  },
  {
    key: "promotions_opt_in",
    label: "Promotions opt-in",
    group: "Contact",
    type: "boolean",
    source: col("promotions_opt_in", "boolean"),
    sortable: true,
  },
  {
    key: "source",
    label: "Source",
    group: "Contact",
    type: "select",
    source: col("source", "text"),
    options: [
      { value: "manual", label: "Manual" },
      { value: "inbox", label: "Inbox" },
      { value: "import_csv", label: "CSV import" },
      { value: "import_sanoflow", label: "Sanoflow import" },
      { value: "import_airtable", label: "Airtable import" },
      { value: "unite", label: "Unite" },
      { value: "api", label: "API" },
      { value: "flow", label: "Flow" },
    ],
    sortable: true,
  },
  {
    key: "next_due_task",
    label: "Next due task",
    group: "Contact",
    type: "datetime",
    source: rel("tasks", "due_at"),
  },
  // Inbox
  {
    key: "last_interaction_at",
    label: "Last interaction date",
    group: "Inbox",
    type: "datetime",
    source: col("last_interaction_at", "timestamptz"),
    sortable: true,
  },
  {
    key: "mentioned_user",
    label: "Mentions",
    group: "Inbox",
    type: "user",
    source: rel("mentions", "user_id"),
    optionsSource: "users",
  },
  {
    key: "conversation_channel",
    label: "Channel",
    group: "Inbox",
    type: "select",
    source: rel("conversations", "channel_id"),
    optionsSource: "channels",
  },
  {
    key: "conversation_status",
    label: "Conversation status",
    group: "Inbox",
    type: "select",
    source: rel("conversations", "status"),
    options: [
      { value: "open", label: "Open" },
      { value: "waiting", label: "Waiting" },
      { value: "closed", label: "Closed" },
    ],
  },
  {
    key: "conversation_ai_tags",
    label: "AI tags",
    group: "Inbox",
    type: "text",
    source: rel("conversations", "ai_tags"),
  },
  // Enquiries
  {
    key: "enquiry_stage",
    label: "Stage",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "stage_id"),
    optionsSource: "stages",
  },
  {
    key: "enquiry_status",
    label: "Enquiry status",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "status"),
    options: [
      { value: "open", label: "Open" },
      { value: "won", label: "Won" },
      { value: "lost", label: "Lost" },
      { value: "disqualified", label: "Disqualified" },
    ],
  },
  {
    key: "enquiry_lost_reason",
    label: "Lost reason",
    group: "Enquiries",
    type: "text",
    source: rel("enquiries", "lost_reason"),
  },
  {
    key: "enquiry_est_value",
    label: "Est. value",
    group: "Enquiries",
    type: "number",
    source: rel("enquiries", "est_value"),
  },
  {
    key: "enquiry_created_at",
    label: "Enquiry created",
    group: "Enquiries",
    type: "datetime",
    source: rel("enquiries", "created_at"),
  },
  {
    key: "enquiry_closed_at",
    label: "Enquiry closed",
    group: "Enquiries",
    type: "datetime",
    source: rel("enquiries", "closed_at"),
  },
  {
    key: "enquiry_created_by",
    label: "Enquiry created by",
    group: "Enquiries",
    type: "user",
    source: rel("enquiries", "created_by"),
    optionsSource: "users",
  },
  {
    key: "enquiry_channel",
    label: "Enquiry channel",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "channel_id"),
    optionsSource: "channels",
  },
  {
    key: "enquiry_location",
    label: "Enquiry location",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "location_id"),
    optionsSource: "locations",
  },
  {
    key: "enquiry_specialist",
    label: "Enquiry specialist",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "specialist_id"),
    optionsSource: "specialists",
  },
  {
    key: "enquiry_service",
    label: "Enquiry service",
    group: "Enquiries",
    type: "select",
    source: rel("enquiries", "service_id"),
    optionsSource: "services",
  },
  {
    key: "enquiry_source",
    label: "Enquiry source",
    group: "Enquiries",
    type: "text",
    source: rel("enquiries", "source"),
  },
  {
    key: "enquiry_count",
    label: "Count of enquiries",
    group: "Enquiries",
    type: "count",
    source: { kind: "count", relation: "enquiries" },
    sortable: true,
  },
  // Appointments
  {
    key: "appointment_date",
    label: "Appointment date",
    group: "Appointments",
    type: "datetime",
    source: rel("appointments", "starts_at"),
  },
  {
    key: "appointment_status",
    label: "Appointment status",
    group: "Appointments",
    type: "select",
    source: rel("appointments", "status"),
    options: [
      { value: "awaiting", label: "Awaiting" },
      { value: "confirmed", label: "Confirmed" },
      { value: "cancelled", label: "Cancelled" },
      { value: "completed", label: "Completed" },
      { value: "no_show", label: "No-show" },
    ],
  },
  {
    key: "appointment_location",
    label: "Appointment location",
    group: "Appointments",
    type: "select",
    source: rel("appointments", "location_id"),
    optionsSource: "locations",
  },
  {
    key: "appointment_specialist",
    label: "Appointment specialist",
    group: "Appointments",
    type: "select",
    source: rel("appointments", "specialist_id"),
    optionsSource: "specialists",
  },
  {
    key: "appointment_service",
    label: "Appointment service",
    group: "Appointments",
    type: "select",
    source: rel("appointments", "service_id"),
    optionsSource: "services",
  },
  {
    key: "appointment_department",
    label: "Appointment department",
    group: "Appointments",
    type: "select",
    source: rel("appointments", "department_id"),
    optionsSource: "departments",
  },
  {
    key: "appointment_created_at",
    label: "Appointment created",
    group: "Appointments",
    type: "datetime",
    source: rel("appointments", "created_at"),
  },
  {
    key: "appointment_created_by",
    label: "Appointment created by",
    group: "Appointments",
    type: "user",
    source: rel("appointments", "created_by"),
    optionsSource: "users",
  },
  {
    key: "appointment_notify_early",
    label: "Notify on early availability",
    group: "Appointments",
    type: "boolean",
    source: rel("appointments", "notify_early"),
  },
  {
    key: "appointment_notes",
    label: "Appointment notes",
    group: "Appointments",
    type: "text",
    source: rel("appointments", "notes"),
  },
  {
    key: "appointment_count",
    label: "Count of appointments",
    group: "Appointments",
    type: "count",
    source: { kind: "count", relation: "appointments" },
    sortable: true,
  },
  // Segments v2 (docs/45 P5). Age band is non-clinical; everything below it comes from visits, diagnoses, doctors or
  // visit dates and is clinical (care programmes only, never marketing). Lifecycle is derived from visit dates, so it
  // is clinical too. Gender and home branch are the existing non-clinical fields above.
  {
    key: "age_band",
    label: "Age band",
    group: "Patient",
    type: "select",
    source: rel("contact_age_band", "age_band"),
    options: AGE_BANDS.map((v) => ({ value: v, label: AGE_BAND_LABELS[v] })),
  },
  {
    key: "lifecycle_stage",
    label: "Lifecycle stage",
    group: "Patient",
    type: "select",
    source: rel("contact_lifecycle", "stage"),
    options: LIFECYCLE_STAGES.map((v) => ({ value: v, label: LIFECYCLE_LABELS[v] })),
    clinical: true,
  },
  {
    key: "last_visit",
    label: "Last visit",
    group: "Patient",
    type: "date",
    source: rel("contact_visit_stats", "last_visit_date"),
    clinical: true,
  },
  {
    key: "visit_count",
    label: "Count of visits",
    group: "Patient",
    type: "count",
    source: { kind: "count", relation: "contact_visit_segments" },
    clinical: true,
  },
  {
    key: "visit_doctor",
    label: "Seen by doctor",
    group: "Patient",
    type: "select",
    source: rel("contact_visit_segments", "specialist_id"),
    optionsSource: "specialists",
    clinical: true,
  },
  {
    key: "visit_department",
    label: "Visit department",
    group: "Patient",
    type: "select",
    source: rel("contact_visit_segments", "department"),
    options: [
      { value: "paediatrics", label: "Paediatrics" },
      { value: "gp", label: "General practice" },
      { value: "gynaecology", label: "Gynaecology" },
      { value: "dermatology", label: "Dermatology" },
      { value: "other", label: "Other" },
    ],
    clinical: true,
  },
  {
    key: "chronic_condition",
    label: "Chronic condition group",
    group: "Patient",
    type: "set",
    source: rel("contact_chronic_groups", "condition_group_id"),
    optionsSource: "condition_groups",
    clinical: true,
  },
  {
    key: "diagnosis_group",
    label: "Diagnosis group (any visit)",
    group: "Patient",
    type: "set",
    source: rel("contact_visit_groups", "condition_group_id"),
    optionsSource: "condition_groups",
    clinical: true,
  },
  // Campaigns
  {
    key: "campaign",
    label: "Received campaign",
    group: "Campaigns",
    type: "set",
    source: rel("campaign_recipients", "campaign_id"),
  },
];

function customFieldType(t: CustomFieldDefInput["type"]): FieldType {
  switch (t) {
    case "number":
      return "number";
    case "date":
      return "date";
    case "boolean":
      return "boolean";
    case "select":
      return "select";
    case "multi_select":
      return "multi_select";
    default:
      return "text";
  }
}

export type BuildRegistryOptions = {
  customFields?: CustomFieldDefInput[];
  /** Relations that exist in this deployment. Defaults to AVAILABLE_RELATIONS. */
  availableRelations?: readonly RelationKey[];
  /**
   * Whether clinical fields (visits, diagnoses, lifecycle ...) are offered. Default true; screens pass false for a
   * member without `clinical.view` so the compiler rejects those fields (health data is never implied by contacts.*).
   */
  clinicalAvailable?: boolean;
};

/** Builds the contact field registry, including the org's custom fields as `custom.<key>`. */
export function buildContactFieldRegistry(opts: BuildRegistryOptions = {}): FieldRegistry {
  const available = new Set<RelationKey>(opts.availableRelations ?? AVAILABLE_RELATIONS);
  const clinicalAvailable = opts.clinicalAvailable ?? true;
  const fields = new Map<string, FieldDef>();

  for (const f of CONTACT_BASE_FIELDS) {
    const relation =
      f.source.kind === "relation" || f.source.kind === "count" ? f.source.relation : null;
    fields.set(f.key, {
      ...f,
      sortable: f.sortable ?? false,
      clinical: f.clinical ?? false,
      available:
        (relation ? available.has(relation) : true) &&
        (clinicalAvailable || !(f.clinical ?? false)),
    });
  }

  for (const cf of opts.customFields ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(cf.key)) continue;
    const key = `custom.${cf.key}`;
    fields.set(key, {
      key,
      label: cf.label,
      group: "Custom fields",
      type: customFieldType(cf.type),
      source: { kind: "custom", key: cf.key },
      options: cf.options ?? undefined,
      available: true,
      sortable: true,
      clinical: false,
    });
  }

  return {
    fields,
    relations: CONTACT_RELATIONS,
    list: () => [...fields.values()],
    get: (key) => fields.get(key),
    require(key) {
      const f = fields.get(key);
      if (!f || !f.available) throw new UnknownFieldError(key);
      return f;
    },
  };
}
