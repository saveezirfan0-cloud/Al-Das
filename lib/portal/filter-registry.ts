import type { FieldDef, FieldRegistry, FieldType, SqlType } from "@/lib/filters/field-registry";
import { UnknownFieldError } from "@/lib/filters/field-registry";
import type { PortalColumn, PortalObjectDef } from "@/lib/portal/types";
import { SYSTEM_COLUMNS } from "@/lib/portal/types";

type Mapping = { type: FieldType; sql: SqlType } | null;

/** Which portal column types can be filtered, and how they compile. Arrays and long text are not. */
function mapColumn(col: PortalColumn): Mapping {
  switch (col.type) {
    case "text":
    case "url":
    case "email":
      return { type: "text", sql: "text" };
    case "number":
      return { type: "number", sql: col.integer ? "integer" : "numeric" };
    case "boolean":
      return { type: "boolean", sql: "boolean" };
    case "date":
      return { type: "date", sql: "date" };
    case "datetime":
      return { type: "datetime", sql: "timestamptz" };
    case "select":
      return { type: "select", sql: "text" };
    case "link":
      return { type: "select", sql: "uuid" };
    case "long_text":
    case "multi_select":
      return null;
  }
}

/**
 * Builds the filter registry for a portal object. Column-only: every field maps to a real column
 * of the backing table, so the compiler (lib/filters/to-sql) needs no portal-specific code and
 * unregistered keys are rejected exactly as for contacts.
 */
export function buildPortalFieldRegistry(
  def: PortalObjectDef,
  linkOptions: Record<string, Array<{ value: string; label: string }>> = {},
): FieldRegistry {
  const fields = new Map<string, FieldDef>();
  for (const col of [...def.columns, ...SYSTEM_COLUMNS]) {
    const m = mapColumn(col);
    if (!m) continue;
    fields.set(col.key, {
      key: col.key,
      label: col.label,
      group: col.group ?? def.label,
      type: m.type,
      source: { kind: "column", column: col.key, sqlType: m.sql },
      options:
        col.type === "link"
          ? (linkOptions[col.key] ?? [])
          : col.type === "select"
            ? col.options
            : undefined,
      available: true,
      sortable: true,
    });
  }
  // Long-text and multi-select columns are sortable-excluded and not filterable; they are still
  // shown in the grid / drawer.
  return {
    fields,
    // No relations for portal objects. The cast keeps the shared registry type without
    // inventing contact relations.
    relations: {} as FieldRegistry["relations"],
    list: () => [...fields.values()],
    get: (key) => fields.get(key),
    require(key) {
      const f = fields.get(key);
      if (!f || !f.available) throw new UnknownFieldError(key);
      return f;
    },
  };
}
