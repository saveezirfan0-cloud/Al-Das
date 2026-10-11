/**
 * Filter field registry for enquiries (alias `e` over public.enquiries). Reuses
 * the lib/filters engine: same AST, compiler and operators as contacts. Only the
 * keys registered here can reach SQL.
 */
import {
  CONTACT_RELATIONS,
  UnknownFieldError,
  type CustomFieldDefInput,
  type FieldDef,
  type FieldRegistry,
  type FieldSource,
  type RelationDef,
  type RelationKey,
  type SqlType,
} from "@/lib/filters/field-registry";
import { ENQUIRY_STATUSES, STATUS_LABELS } from "@/lib/enquiries/constants";

/** Alias of public.enquiries in enquiries_search / _count / _ids / _stage_counts. */
export const ENQUIRY_ALIAS = "e";

const ENQUIRY_RELATIONS: Record<RelationKey, RelationDef> = {
  ...CONTACT_RELATIONS,
  // For enquiries the `tasks` relation joins on enquiry_id, not contact_id.
  tasks: {
    key: "tasks",
    table: "public.tasks",
    contactColumn: "enquiry_id",
    columns: { due_at: "timestamptz", done: "boolean", type: "text" },
    extraWhere: "r.done = false",
  },
};

const col = (column: string, sqlType: SqlType): FieldSource => ({ kind: "column", column, sqlType });

type Def = Omit<FieldDef, "available" | "sortable"> & { sortable?: boolean };

const BASE: Def[] = [
  { key: "number", label: "Enquiry ID", group: "Enquiry", type: "number", source: col("number", "integer"), sortable: true },
  { key: "title", label: "Title", group: "Enquiry", type: "text", source: col("title", "text"), sortable: true },
  {
    key: "status",
    label: "Status",
    group: "Enquiry",
    type: "select",
    source: col("status", "text"),
    options: ENQUIRY_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
    sortable: true,
  },
  { key: "lost_reason", label: "Lost / disqualified reason", group: "Enquiry", type: "text", source: col("lost_reason", "text") },
  { key: "pipeline", label: "Pipeline", group: "Enquiry", type: "select", source: col("pipeline_id", "uuid"), optionsSource: "pipelines" },
  { key: "stage", label: "Stage", group: "Enquiry", type: "select", source: col("stage_id", "uuid"), optionsSource: "stages" },
  { key: "assignee", label: "Assigned to", group: "Enquiry", type: "user", source: col("assignee_id", "uuid"), optionsSource: "users" },
  { key: "created_by", label: "Created by", group: "Enquiry", type: "user", source: col("created_by", "uuid"), optionsSource: "users" },
  { key: "source", label: "Source", group: "Enquiry", type: "select", source: col("source", "text"), optionsSource: "sources" },
  { key: "channel", label: "Channel", group: "Enquiry", type: "select", source: col("channel_id", "uuid"), optionsSource: "channels" },
  { key: "est_value", label: "Estimated value", group: "Enquiry", type: "number", source: col("est_value", "numeric"), sortable: true },
  { key: "location", label: "Location", group: "Clinic", type: "select", source: col("location_id", "uuid"), optionsSource: "locations" },
  { key: "department", label: "Department", group: "Clinic", type: "select", source: col("department_id", "uuid"), optionsSource: "departments" },
  { key: "specialist", label: "Specialist", group: "Clinic", type: "select", source: col("specialist_id", "uuid"), optionsSource: "specialists" },
  { key: "service", label: "Service", group: "Clinic", type: "select", source: col("service_id", "uuid"), optionsSource: "services" },
  { key: "appt_date", label: "Appointment date", group: "Clinic", type: "datetime", source: col("appt_date", "timestamptz"), sortable: true },
  { key: "created_at", label: "Created", group: "Dates", type: "datetime", source: col("created_at", "timestamptz"), sortable: true },
  { key: "stage_entered_at", label: "Entered stage", group: "Dates", type: "datetime", source: col("stage_entered_at", "timestamptz"), sortable: true },
  { key: "closed_at", label: "Closed", group: "Dates", type: "datetime", source: col("closed_at", "timestamptz"), sortable: true },
  { key: "sla_due_at", label: "SLA due", group: "SLA", type: "datetime", source: col("sla_due_at", "timestamptz"), sortable: true },
  { key: "sla_breached_at", label: "SLA breached", group: "SLA", type: "datetime", source: col("sla_breached_at", "timestamptz") },
  { key: "first_touch_at", label: "First touched", group: "SLA", type: "datetime", source: col("first_touch_at", "timestamptz") },
  {
    key: "open_task_count",
    label: "Open tasks",
    group: "Tasks",
    type: "count",
    source: { kind: "count", relation: "tasks" },
    sortable: true,
  },
];

function customType(t: CustomFieldDefInput["type"]): FieldDef["type"] {
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

export function buildEnquiryFieldRegistry(
  opts: { customFields?: CustomFieldDefInput[] } = {},
): FieldRegistry {
  const fields = new Map<string, FieldDef>();
  for (const f of BASE) fields.set(f.key, { ...f, sortable: f.sortable ?? false, available: true });
  for (const cf of opts.customFields ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(cf.key)) continue;
    const key = `custom.${cf.key}`;
    fields.set(key, {
      key,
      label: cf.label,
      group: "Custom fields",
      type: customType(cf.type),
      source: { kind: "custom", key: cf.key },
      options: cf.options ?? undefined,
      available: true,
      sortable: true,
    });
  }
  return {
    fields,
    relations: ENQUIRY_RELATIONS,
    list: () => [...fields.values()],
    get: (key) => fields.get(key),
    require(key) {
      const f = fields.get(key);
      if (!f || !f.available) throw new UnknownFieldError(key);
      return f;
    },
  };
}
