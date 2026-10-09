/** Shared enquiry constants. Framework-free: used by server, client and tests. */

export const ENQUIRY_STATUSES = ["open", "won", "lost", "disqualified"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const STATUS_LABELS: Record<EnquiryStatus, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

/** Statuses that need a reason. */
export const REASON_STATUSES: readonly EnquiryStatus[] = ["lost", "disqualified"];

/** Fields a pipeline can show on its Kanban cards (pipelines.card_fields). */
export const CARD_FIELD_OPTIONS = [
  { key: "number", label: "Enquiry ID" },
  { key: "contact", label: "Contact name" },
  { key: "phone", label: "Phone" },
  { key: "source", label: "Source" },
  { key: "assignee", label: "Assigned to" },
  { key: "created_at", label: "Created" },
  { key: "created_by", label: "Created by" },
  { key: "est_value", label: "Estimated value" },
  { key: "appt_date", label: "Appointment date" },
  { key: "location", label: "Location" },
  { key: "department", label: "Department" },
  { key: "specialist", label: "Specialist" },
  { key: "service", label: "Service" },
  { key: "stage_age", label: "Time in stage" },
] as const;

export type CardFieldKey = (typeof CARD_FIELD_OPTIONS)[number]["key"];
export const CARD_FIELD_KEYS: readonly string[] = CARD_FIELD_OPTIONS.map((f) => f.key);
export const DEFAULT_CARD_FIELDS: readonly CardFieldKey[] = [
  "number",
  "contact",
  "source",
  "created_at",
];

/** Columns the enquiries table view offers (column chooser). */
export const TABLE_COLUMN_KEYS = [
  "number",
  "title",
  "contact",
  "phone",
  "pipeline",
  "stage",
  "status",
  "lost_reason",
  "assignee",
  "source",
  "channel",
  "est_value",
  "location",
  "department",
  "specialist",
  "service",
  "appt_date",
  "created_at",
  "created_by",
  "stage_entered_at",
  "closed_at",
  "sla",
] as const;
export type TableColumnKey = (typeof TABLE_COLUMN_KEYS)[number];

/** Stage colours (tailwind-friendly names shared with tags). */
export const STAGE_COLORS = ["gray", "blue", "green", "amber", "red", "purple", "pink", "teal"] as const;

export const ENQUIRY_EVENT_NAMES = [
  "created",
  "assigned",
  "stage_changed",
  "status_changed",
  "sla_breached",
] as const;
export type EnquiryNotifyEvent = (typeof ENQUIRY_EVENT_NAMES)[number];

export const MAX_REASON_LENGTH = 500;
