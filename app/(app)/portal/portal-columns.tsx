"use client";

import type { DataGridColumn } from "@/components/data-grid/data-grid";
import { formatDate, formatDateTime, tagClass } from "@/lib/contacts/format";
import type { PortalTag } from "@/lib/portal/bulk-edit";
import { allColumns, displayValue } from "@/lib/portal/field-types";
import type { PortalColumn, PortalObjectDef, PortalRow } from "@/lib/portal/types";

const FILTERABLE_SORT = new Set(["long_text", "multi_select"]);

function cell(
  col: PortalColumn,
  r: PortalRow,
  opts: { timezone: string; links: Record<string, Record<string, string>> },
): React.ReactNode {
  const v = r[col.key];
  if (v === null || v === undefined || v === "") return "";
  switch (col.type) {
    case "boolean":
      return v ? "Yes" : <span className="text-muted-foreground">No</span>;
    case "date":
      return <span className="tabular-nums">{formatDate(String(v))}</span>;
    case "datetime":
      return (
        <span className="text-muted-foreground tabular-nums">
          {formatDateTime(String(v), opts.timezone)}
        </span>
      );
    case "link":
      return opts.links[col.key]?.[String(v)] ?? <span className="text-muted-foreground">…</span>;
    case "multi_select":
      return Array.isArray(v) ? (
        <span className="flex gap-1">
          {v.slice(0, 3).map((x) => (
            <span key={String(x)} className="bg-muted rounded px-1.5 py-0.5 text-xs">
              {String(x)}
            </span>
          ))}
          {v.length > 3 && <span className="text-muted-foreground text-xs">+{v.length - 3}</span>}
        </span>
      ) : (
        ""
      );
    case "number":
      return <span className="tabular-nums">{String(v)}</span>;
    case "long_text":
      return <span className="text-muted-foreground block truncate">{String(v)}</span>;
    default:
      return displayValue(col, v);
  }
}

/** Column id of the portal tags column (not a database column; never sorted or filtered as a field). */
export const TAGS_COLUMN_ID = "_tags";

function tagChips(ids: string[] | undefined, byId: Map<string, PortalTag>): React.ReactNode {
  const list = (ids ?? []).map((id) => byId.get(id)).filter((t): t is PortalTag => !!t);
  if (list.length === 0) return "";
  return (
    <span className="flex gap-1">
      {list.slice(0, 3).map((t) => (
        <span key={t.id} className={`rounded px-1.5 py-0.5 text-xs ${tagClass(t.color)}`}>
          {t.name}
        </span>
      ))}
      {list.length > 3 && <span className="text-muted-foreground text-xs">+{list.length - 3}</span>}
    </span>
  );
}

/** Grid columns for a portal object: one per declared column, read-only system columns, then tags. */
export function buildPortalColumns(
  def: PortalObjectDef,
  opts: {
    timezone: string;
    links: Record<string, Record<string, string>>;
    tags?: PortalTag[];
    rowTags?: Record<string, string[]>;
  },
): DataGridColumn<PortalRow>[] {
  const byId = new Map((opts.tags ?? []).map((t) => [t.id, t]));
  const tagColumn: DataGridColumn<PortalRow> = {
    id: TAGS_COLUMN_ID,
    label: "Tags",
    header: "Tags",
    accessorFn: (r: PortalRow) => r.id,
    cell: ({ row }) => tagChips(opts.rowTags?.[row.original.id], byId),
    size: 200,
  };
  return [...fieldColumns(def, opts), tagColumn];
}

function fieldColumns(
  def: PortalObjectDef,
  opts: { timezone: string; links: Record<string, Record<string, string>> },
): DataGridColumn<PortalRow>[] {
  return allColumns(def).map((col, i) => ({
    id: col.key,
    label: col.label,
    header: col.label,
    accessorFn: (r: PortalRow) => r.id,
    cell: ({ row }) => cell(col, row.original, opts),
    sortKey: FILTERABLE_SORT.has(col.type) ? undefined : col.key,
    size: col.type === "long_text" ? 260 : col.type === "boolean" ? 110 : 170,
    locked: i === 0,
    meta: { defaultHidden: !!col.defaultHidden },
  }));
}
