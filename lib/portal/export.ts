import { toCsv } from "@/lib/csv";
import { displayValue } from "@/lib/portal/field-types";
import { allColumns } from "@/lib/portal/field-types";
import type { PortalColumn, PortalObjectDef, PortalRow } from "@/lib/portal/types";

/** Columns exported: everything except those the caller hides, in display order. */
export function exportColumns(def: PortalObjectDef, only?: string[] | null): PortalColumn[] {
  const cols = allColumns(def);
  if (!only || only.length === 0) return cols;
  const byKey = new Map(cols.map((c) => [c.key, c]));
  return only.map((k) => byKey.get(k)).filter((c): c is PortalColumn => !!c);
}

/**
 * CSV for a set of rows. Link columns export the display title when `linkTitles` has it, else
 * the id. Formula-injection characters are neutralised by lib/csv.
 */
export function portalRowsToCsv(
  def: PortalObjectDef,
  rows: PortalRow[],
  opts: { columns?: string[] | null; linkTitles?: Record<string, Record<string, string>> } = {},
): string {
  const cols = exportColumns(def, opts.columns);
  const headers = cols.map((c) => c.label);
  const body = rows.map((r) =>
    cols.map((c) => {
      const v = r[c.key];
      if (c.type === "link" && typeof v === "string") return opts.linkTitles?.[c.key]?.[v] ?? v;
      return displayValue(c, v);
    }),
  );
  return toCsv(headers, body);
}
