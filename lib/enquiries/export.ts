/** CSV export of enquiries and their activity. Pure; callers have already checked permissions. */
import { toCsv } from "@/lib/csv";

export type ExportRow = {
  number: number;
  title: string;
  patient: string;
  phone: string;
  pipeline: string;
  stage: string;
  status: string;
  reason: string;
  assignee: string;
  source: string;
  channel: string;
  location: string;
  department: string;
  specialist: string;
  service: string;
  appointment_at: string;
  est_value: string;
  created_at: string;
  closed_at: string;
  created_by: string;
  custom: Record<string, string>;
};

const BASE_HEADERS: Array<[keyof Omit<ExportRow, "custom">, string]> = [
  ["number", "ID"],
  ["title", "Title"],
  ["patient", "Patient"],
  ["phone", "Phone"],
  ["pipeline", "Pipeline"],
  ["stage", "Stage"],
  ["status", "Status"],
  ["reason", "Reason"],
  ["assignee", "Assigned to"],
  ["source", "Source"],
  ["channel", "Channel"],
  ["location", "Location"],
  ["department", "Department"],
  ["specialist", "Specialist"],
  ["service", "Service"],
  ["appointment_at", "Appointment"],
  ["est_value", "Est. value"],
  ["created_at", "Created"],
  ["closed_at", "Closed"],
  ["created_by", "Created by"],
];

export function enquiriesCsv(
  rows: ExportRow[],
  customLabels: Array<{ key: string; label: string }>,
): string {
  const headers = [...BASE_HEADERS.map(([, h]) => h), ...customLabels.map((c) => c.label)];
  const body = rows.map((r) => [
    ...BASE_HEADERS.map(([k]) => r[k]),
    ...customLabels.map((c) => r.custom[c.key] ?? ""),
  ]);
  return toCsv(headers, body);
}

export type ActivityRow = {
  at: string;
  enquiry_number: number | null;
  type: string;
  actor: string;
  detail: string;
};

export function activityCsv(rows: ActivityRow[]): string {
  return toCsv(
    ["When", "Enquiry", "Event", "By", "Detail"],
    rows.map((r) => [r.at, r.enquiry_number ?? "", r.type, r.actor, r.detail]),
  );
}

/** One-line description of a timeline payload for the activity export (no free-form message text). */
export function describeActivity(type: string, payload: unknown): string {
  const p = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (type) {
    case "enquiry.created":
      return `Created in ${str(p.pipeline)} / ${str(p.stage)}`.trim();
    case "enquiry.stage_changed":
      return `${str(p.from_stage)} → ${str(p.to_stage)}`;
    case "enquiry.pipeline_changed":
      return `${str(p.from_pipeline)} → ${str(p.to_pipeline)}`;
    case "enquiry.status_changed":
      return `${str(p.from)} → ${str(p.to)}${p.reason ? ` (${str(p.reason)})` : ""}`;
    case "enquiry.assigned":
      return `Assigned to ${str(p.assignee) || "nobody"}`;
    default:
      return "";
  }
}
