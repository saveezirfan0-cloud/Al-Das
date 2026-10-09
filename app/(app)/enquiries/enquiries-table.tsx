"use client";

import type { DataGridColumn } from "@/components/data-grid/data-grid";
import { formatCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";
import { ENQUIRY_COLUMNS } from "@/lib/enquiries/columns";
import type { EnquiryRow } from "@/lib/enquiries/types";
import { formatPhone } from "@/lib/phone";

import { StageDot, StatusBadge } from "./badges";
import { ago, formatMoney, formatWhen } from "./format";

const WIDTH: Record<string, number> = {
  number: 80,
  title: 220,
  patient: 190,
  phone: 150,
  pipeline: 150,
  stage: 150,
  status: 120,
  assignee: 150,
  source: 120,
  channel: 130,
  location: 140,
  department: 140,
  specialist: 150,
  service: 150,
  appointment_at: 170,
  est_value: 110,
  time_in_stage: 130,
  created_at: 170,
  closed_at: 170,
  created_by: 150,
};

/** Column definitions for the enquiries table; sortable ones map to whitelisted database columns. */
export function buildEnquiryColumns(opts: {
  timezone: string;
  customFields: CustomFieldDef[];
}): DataGridColumn<EnquiryRow>[] {
  const cells: Record<string, (r: EnquiryRow) => React.ReactNode> = {
    number: (r) => <span className="tabular-nums">#{r.number}</span>,
    title: (r) => <span className="font-medium">{r.title}</span>,
    patient: (r) => r.patient,
    phone: (r) => <span className="tabular-nums">{r.phone ? formatPhone(r.phone) : ""}</span>,
    pipeline: (r) => r.pipeline_name,
    stage: (r) => (
      <span className="flex items-center gap-1.5">
        <StageDot color={r.stage_color} /> {r.stage_name}
      </span>
    ),
    status: (r) => <StatusBadge status={r.status} />,
    assignee: (r) => r.assignee_name,
    source: (r) => r.source ?? "",
    channel: (r) => r.channel_name,
    location: (r) => r.location_name,
    department: (r) => r.department_name,
    specialist: (r) => r.specialist_name,
    service: (r) => r.service_name,
    appointment_at: (r) => formatWhen(r.appointment_at, opts.timezone),
    est_value: (r) => formatMoney(r.est_value),
    time_in_stage: (r) => (
      <span title={formatWhen(r.stage_entered_at, opts.timezone)}>{ago(r.stage_entered_at)}</span>
    ),
    created_at: (r) => formatWhen(r.created_at, opts.timezone),
    closed_at: (r) => formatWhen(r.closed_at, opts.timezone),
    created_by: (r) => r.created_by_name,
  };

  const base = ENQUIRY_COLUMNS.map<DataGridColumn<EnquiryRow>>((c) => ({
    id: c.id,
    label: c.label,
    header: c.label,
    accessorFn: (r) => r.id,
    cell: ({ row }) => cells[c.id]?.(row.original) ?? null,
    sortKey: c.sortKey,
    size: WIDTH[c.id] ?? 140,
    locked: c.id === "number",
    meta: { defaultHidden: !c.default },
  }));

  const custom = opts.customFields.map<DataGridColumn<EnquiryRow>>((def) => ({
    id: `custom:${def.key}`,
    label: def.label,
    header: def.label,
    accessorFn: (r) => r.id,
    cell: ({ row }) => formatCustomValue(def, row.original.custom[def.key]),
    size: 150,
    meta: { defaultHidden: true },
  }));
  return [...base, ...custom];
}
