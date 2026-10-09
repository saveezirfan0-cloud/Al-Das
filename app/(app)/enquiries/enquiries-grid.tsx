"use client";

import type { DataGridColumn } from "@/components/data-grid/data-grid";
import { Badge } from "@/components/ui/badge";
import { formatCustomValue } from "@/lib/contacts/custom-values";
import { formatDate, formatDateTime, tagClass, timeAgo } from "@/lib/contacts/format";
import { STATUS_LABELS, type EnquiryStatus } from "@/lib/enquiries/constants";
import type { EnquiryRow } from "@/lib/enquiries/query";
import { slaState } from "@/lib/enquiries/sla";
import { formatPhone } from "@/lib/phone";

import type { EnquiriesBootstrap } from "./types";

export const STATUS_VARIANT: Record<
  EnquiryStatus,
  "secondary" | "success" | "destructive" | "warning"
> = {
  open: "secondary",
  won: "success",
  lost: "destructive",
  disqualified: "warning",
};

export function StatusBadge({ status }: { status: string }) {
  const s = status as EnquiryStatus;
  return <Badge variant={STATUS_VARIANT[s] ?? "secondary"}>{STATUS_LABELS[s] ?? status}</Badge>;
}

export function SlaBadge({ row }: { row: EnquiryRow }) {
  const state = slaState(
    {
      status: row.status as EnquiryStatus,
      sla_due_at: row.sla_due_at,
      first_touch_at: row.first_touch_at,
      created_at: row.created_at,
    },
    new Date(),
  );
  if (state === "none" || state === "ok") return null;
  if (state === "met") return <Badge variant="outline">SLA met</Badge>;
  if (state === "due_soon") return <Badge variant="warning">SLA due soon</Badge>;
  return <Badge variant="destructive">SLA breached</Badge>;
}

export function lookupMaps(b: EnquiriesBootstrap) {
  const m = (list: Array<{ id: string; name: string }>) => new Map(list.map((x) => [x.id, x.name]));
  return {
    pipeline: new Map(b.pipelines.map((p) => [p.id, p.name])),
    stage: new Map(b.pipelines.flatMap((p) => p.stages.map((s) => [s.id, s] as const))),
    user: new Map(b.users.map((u) => [u.id, u.label])),
    location: m(b.lookups.locations),
    department: m(b.lookups.departments),
    specialist: m(b.lookups.specialists),
    service: m(b.lookups.services),
    channel: m(b.lookups.channels),
  };
}
export type LookupMaps = ReturnType<typeof lookupMaps>;

export function buildEnquiryColumns(b: EnquiriesBootstrap): DataGridColumn<EnquiryRow>[] {
  const lk = lookupMaps(b);
  const col = (
    id: string,
    label: string,
    cell: (r: EnquiryRow) => React.ReactNode,
    extra: Partial<DataGridColumn<EnquiryRow>> & { defaultHidden?: boolean } = {},
  ): DataGridColumn<EnquiryRow> => {
    const { defaultHidden, ...rest } = extra;
    return {
      id,
      label,
      header: label,
      accessorFn: (r) => r.id,
      cell: ({ row }) => cell(row.original),
      meta: { defaultHidden: !!defaultHidden },
      ...rest,
    };
  };

  const base: DataGridColumn<EnquiryRow>[] = [
    col("number", "ID", (r) => <span className="tabular-nums">#{r.number}</span>, {
      sortKey: "number",
      size: 80,
      locked: true,
    }),
    col("title", "Title", (r) => <span className="font-medium">{r.title}</span>, {
      sortKey: "title",
      size: 240,
    }),
    col("contact", "Contact", (r) => r.contact?.full_name || "—", { size: 180 }),
    col(
      "phone",
      "Phone",
      (r) => <span className="tabular-nums">{formatPhone(r.contact?.phone_e164 ?? null)}</span>,
      { size: 150 },
    ),
    col("pipeline", "Pipeline", (r) => lk.pipeline.get(r.pipeline_id) ?? "", { size: 150 }),
    col(
      "stage",
      "Stage",
      (r) => {
        const s = lk.stage.get(r.stage_id);
        return s ? (
          <span className={`rounded px-1.5 py-0.5 text-xs ${tagClass(s.color)}`}>{s.name}</span>
        ) : (
          ""
        );
      },
      { size: 140 },
    ),
    col("status", "Status", (r) => <StatusBadge status={r.status} />, {
      sortKey: "status",
      size: 120,
    }),
    col("lost_reason", "Reason", (r) => r.lost_reason ?? "", { size: 180, defaultHidden: true }),
    col(
      "assignee",
      "Assigned to",
      (r) => (r.assignee_id ? (lk.user.get(r.assignee_id) ?? "Unknown") : ""),
      { size: 160 },
    ),
    col("source", "Source", (r) => r.source ?? "", { size: 120 }),
    col("channel", "Channel", (r) => (r.channel_id ? (lk.channel.get(r.channel_id) ?? "") : ""), {
      size: 130,
      defaultHidden: true,
    }),
    col(
      "est_value",
      "Est. value",
      (r) =>
        r.est_value === null ? (
          ""
        ) : (
          <span className="tabular-nums">{Number(r.est_value).toLocaleString()}</span>
        ),
      { sortKey: "est_value", size: 110, defaultHidden: true },
    ),
    col(
      "location",
      "Location",
      (r) => (r.location_id ? (lk.location.get(r.location_id) ?? "") : ""),
      { size: 140, defaultHidden: true },
    ),
    col(
      "department",
      "Department",
      (r) => (r.department_id ? (lk.department.get(r.department_id) ?? "") : ""),
      { size: 140, defaultHidden: true },
    ),
    col(
      "specialist",
      "Specialist",
      (r) => (r.specialist_id ? (lk.specialist.get(r.specialist_id) ?? "") : ""),
      { size: 150, defaultHidden: true },
    ),
    col("service", "Service", (r) => (r.service_id ? (lk.service.get(r.service_id) ?? "") : ""), {
      size: 150,
      defaultHidden: true,
    }),
    col("appt_date", "Appointment", (r) => formatDateTime(r.appt_date, b.timezone), {
      sortKey: "appt_date",
      size: 160,
      defaultHidden: true,
    }),
    col("created_at", "Created", (r) => formatDateTime(r.created_at, b.timezone), {
      sortKey: "created_at",
      size: 160,
    }),
    col(
      "created_by",
      "Created by",
      (r) => (r.created_by ? (lk.user.get(r.created_by) ?? "") : ""),
      { size: 150, defaultHidden: true },
    ),
    col("stage_entered_at", "In stage", (r) => timeAgo(r.stage_entered_at).replace(" ago", ""), {
      sortKey: "stage_entered_at",
      size: 110,
      defaultHidden: true,
    }),
    col("closed_at", "Closed", (r) => formatDate(r.closed_at, b.timezone), {
      sortKey: "closed_at",
      size: 120,
      defaultHidden: true,
    }),
    col("sla", "SLA", (r) => <SlaBadge row={r} />, { sortKey: "sla_due_at", size: 130 }),
  ];

  const custom = b.customFields.map((f) =>
    col(`custom.${f.key}`, f.label, (r) => formatCustomValue(f, r.custom[f.key]), {
      sortKey: `custom.${f.key}`,
      size: 150,
      defaultHidden: true,
    }),
  );
  return [...base, ...custom];
}
