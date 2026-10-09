/** Column and card-field registries for the enquiry table, Kanban cards and export. Pure. */

/** Columns the table may sort by (database columns only: the sort key is never user-supplied SQL). */
export const SORTABLE_COLUMNS = [
  "number",
  "title",
  "status",
  "source",
  "est_value",
  "appointment_at",
  "stage_entered_at",
  "created_at",
  "closed_at",
  "updated_at",
] as const;
export type SortableColumn = (typeof SORTABLE_COLUMNS)[number];

export function isSortable(v: unknown): v is SortableColumn {
  return typeof v === "string" && (SORTABLE_COLUMNS as readonly string[]).includes(v);
}

export type EnquiryColumn = {
  id: string;
  label: string;
  sortKey?: SortableColumn;
  /** Visible in the table by default. */
  default: boolean;
};

export const ENQUIRY_COLUMNS: EnquiryColumn[] = [
  { id: "number", label: "ID", sortKey: "number", default: true },
  { id: "title", label: "Title", sortKey: "title", default: true },
  { id: "patient", label: "Patient", default: true },
  { id: "phone", label: "Phone", default: true },
  { id: "pipeline", label: "Pipeline", default: false },
  { id: "stage", label: "Stage", default: true },
  { id: "status", label: "Status", sortKey: "status", default: true },
  { id: "assignee", label: "Assigned to", default: true },
  { id: "source", label: "Source", sortKey: "source", default: true },
  { id: "channel", label: "Channel", default: false },
  { id: "location", label: "Location", default: false },
  { id: "department", label: "Department", default: false },
  { id: "specialist", label: "Specialist", default: false },
  { id: "service", label: "Service", default: false },
  { id: "appointment_at", label: "Appointment", sortKey: "appointment_at", default: false },
  { id: "est_value", label: "Est. value", sortKey: "est_value", default: false },
  { id: "time_in_stage", label: "In stage since", sortKey: "stage_entered_at", default: false },
  { id: "created_at", label: "Created", sortKey: "created_at", default: true },
  { id: "closed_at", label: "Closed", sortKey: "closed_at", default: false },
  { id: "created_by", label: "Created by", default: false },
];

/** Fields a pipeline can show on its Kanban cards. */
export const CARD_FIELDS = [
  { key: "phone", label: "Phone" },
  { key: "source", label: "Source" },
  { key: "assignee", label: "Assigned to" },
  { key: "created", label: "Created" },
  { key: "channel", label: "Channel" },
  { key: "location", label: "Location" },
  { key: "specialist", label: "Specialist" },
  { key: "service", label: "Service" },
  { key: "appointment", label: "Appointment" },
  { key: "est_value", label: "Est. value" },
  { key: "time_in_stage", label: "Time in stage" },
] as const;
export type CardFieldKey = (typeof CARD_FIELDS)[number]["key"];

export function isCardField(v: unknown): v is CardFieldKey {
  return typeof v === "string" && CARD_FIELDS.some((f) => f.key === v);
}

export const DEFAULT_CARD_FIELDS: CardFieldKey[] = ["phone", "source", "assignee", "created"];
