"use client";

import type { DataGridColumn } from "@/components/data-grid/data-grid";
import { formatCustomValue, type CustomFieldDef } from "@/lib/contacts/custom-values";
import { displayName, formatDate, formatDateTime, tagClass, timeAgo } from "@/lib/contacts/format";
import type { ContactListRow } from "@/lib/contacts/query";
import { formatPhone } from "@/lib/phone";

const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  inbox: "Inbox",
  import_csv: "CSV import",
  import_sanoflow: "Sanoflow import",
  import_airtable: "Airtable import",
  unite: "Unite",
  api: "API",
  flow: "Flow",
};

export function buildContactColumns(opts: {
  customFields: CustomFieldDef[];
  timezone: string;
  users: Array<{ id: string; label: string }>;
}): DataGridColumn<ContactListRow>[] {
  const userName = (id: string | null) => (id ? (opts.users.find((u) => u.id === id)?.label ?? "Unknown") : "");
  const col = (
    id: string,
    label: string,
    cell: (r: ContactListRow) => React.ReactNode,
    extra: Partial<DataGridColumn<ContactListRow>> & { defaultHidden?: boolean } = {},
  ): DataGridColumn<ContactListRow> => {
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

  const base: DataGridColumn<ContactListRow>[] = [
    col("full_name", "Name", (r) => <span className="font-medium">{displayName(r)}</span>, { sortKey: "full_name", size: 220, locked: true }),
    col("phone", "Phone", (r) => <span className="tabular-nums">{formatPhone(r.phone_e164)}</span>, { sortKey: "phone", size: 160 }),
    col("email", "Email", (r) => r.email ?? "", { sortKey: "email", size: 200, defaultHidden: true }),
    col("gender", "Gender", (r) => (r.gender ? r.gender[0].toUpperCase() + r.gender.slice(1) : ""), { sortKey: "gender", size: 100 }),
    col("nationality", "Nationality", (r) => r.nationality ?? "", { sortKey: "nationality", size: 140 }),
    col(
      "tags",
      "Tags",
      (r) => (
        <span className="flex gap-1">
          {r.tags.map((t) => (
            <span key={t.id} className={`rounded px-1.5 py-0.5 text-xs ${tagClass(t.color)}`}>
              {t.name}
            </span>
          ))}
        </span>
      ),
      { size: 200 },
    ),
    col("country", "Country", (r) => r.country ?? "", { sortKey: "country", size: 90, defaultHidden: true }),
    col("language", "Language", (r) => r.language ?? "", { sortKey: "language", size: 100, defaultHidden: true }),
    col("dob", "Date of birth", (r) => formatDate(r.dob), { sortKey: "dob", size: 130, defaultHidden: true }),
    col("label", "Label", (r) => r.label ?? "", { sortKey: "label", size: 120, defaultHidden: true }),
    col("owner", "Owner", (r) => userName(r.owner_id), { size: 150, defaultHidden: true }),
    col("assignee", "Assignee", (r) => userName(r.assignee_id), { size: 150, defaultHidden: true }),
    col("source", "Source", (r) => SOURCE_LABELS[r.source] ?? r.source, { sortKey: "source", size: 130, defaultHidden: true }),
    col("external_id", "External ID", (r) => r.external_id ?? "", { sortKey: "external_id", size: 130, defaultHidden: true }),
    col("promotions_opt_in", "Promotions opt-in", (r) => (r.promotions_opt_in ? "Yes" : "No"), { sortKey: "promotions_opt_in", size: 140, defaultHidden: true }),
    col("stop_marketing", "Stop marketing", (r) => (r.stop_marketing ? <span className="text-destructive">Yes</span> : "No"), { sortKey: "stop_marketing", size: 130, defaultHidden: true }),
    col(
      "last_interaction_at",
      "Last interaction",
      (r) => (
        <span title={formatDateTime(r.last_interaction_at, opts.timezone)} className="text-muted-foreground">
          {r.last_interaction_at ? timeAgo(r.last_interaction_at) : "Never"}
        </span>
      ),
      { sortKey: "last_interaction_at", size: 150 },
    ),
    col("created_at", "Created", (r) => <span className="text-muted-foreground">{formatDate(r.created_at, opts.timezone)}</span>, { sortKey: "created_at", size: 120 }),
    col("updated_at", "Updated", (r) => <span className="text-muted-foreground">{formatDate(r.updated_at, opts.timezone)}</span>, { sortKey: "updated_at", size: 120, defaultHidden: true }),
  ];

  const custom = opts.customFields.map((f) =>
    col(`custom.${f.key}`, f.label, (r) => formatCustomValue(f, r.custom?.[f.key]), { sortKey: `custom.${f.key}`, size: 150, defaultHidden: true }),
  );

  return [...base, ...custom];
}
