import { toCsv } from "@/lib/csv";
import { STATUS_LABELS, type EnquiryStatus } from "@/lib/enquiries/constants";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import { formatCustomValue } from "@/lib/contacts/custom-values";

export type ExportableEnquiry = {
  number: number;
  title: string;
  status: EnquiryStatus;
  lost_reason: string | null;
  pipeline: string;
  stage: string;
  contact_name: string | null;
  contact_phone: string | null;
  assignee: string | null;
  source: string | null;
  channel: string | null;
  est_value: number | null;
  location: string | null;
  department: string | null;
  specialist: string | null;
  service: string | null;
  appt_date: string | null;
  created_at: string;
  created_by: string | null;
  closed_at: string | null;
  custom: Record<string, unknown>;
};

const BASE_HEADERS = [
  "Enquiry ID",
  "Title",
  "Status",
  "Reason",
  "Pipeline",
  "Stage",
  "Contact",
  "Phone",
  "Assigned to",
  "Source",
  "Channel",
  "Estimated value",
  "Location",
  "Department",
  "Specialist",
  "Service",
  "Appointment date",
  "Created",
  "Created by",
  "Closed",
] as const;

/** CSV for an enquiry export. Custom-field columns follow the base columns. toCsv guards against spreadsheet formula injection. */
export function enquiriesToCsv(
  rows: readonly ExportableEnquiry[],
  customFields: readonly CustomFieldDef[],
): string {
  const headers = [...BASE_HEADERS, ...customFields.map((f) => f.label)];
  const body = rows.map((r) => [
    String(r.number),
    r.title,
    STATUS_LABELS[r.status],
    r.lost_reason ?? "",
    r.pipeline,
    r.stage,
    r.contact_name ?? "",
    r.contact_phone ?? "",
    r.assignee ?? "",
    r.source ?? "",
    r.channel ?? "",
    r.est_value === null ? "" : String(r.est_value),
    r.location ?? "",
    r.department ?? "",
    r.specialist ?? "",
    r.service ?? "",
    r.appt_date ?? "",
    r.created_at,
    r.created_by ?? "",
    r.closed_at ?? "",
    ...customFields.map((f) => formatCustomValue(f, r.custom[f.key])),
  ]);
  return toCsv(headers, body);
}
