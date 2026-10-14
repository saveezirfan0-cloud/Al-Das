import { z } from "zod";

import { columnSchema, writableColumns } from "@/lib/portal/field-types";
import type { PortalColumn, PortalObjectDef } from "@/lib/portal/types";

/**
 * Portal bulk edit and bulk tagging, the pure half (docs/33_PORTAL_BULK_EDIT_TAGS_NOTES.md). Validates what the
 * person asked for against the object's code registry before anything reaches the database; the server action and
 * public.portal_bulk_update do the rest. Framework-free: shared by server, client and tests.
 */

/** A tag with scope 'portal' (public.tags). */
export type PortalTag = { id: string; name: string; color: string };

/** Most records one bulk action may touch (also enforced in SQL by portal_bulk_update). */
export const BULK_EDIT_MAX = 500;
/** Most tags one bulk action may add or remove. */
export const BULK_TAGS_MAX = 20;

const uuid = z.string().uuid();

/** Ids of the selected records: uuids, de-duplicated, 1 to BULK_EDIT_MAX. */
export const bulkIdsSchema = z
  .array(uuid)
  .min(1, "Select at least one record.")
  .max(BULK_EDIT_MAX, `Select at most ${BULK_EDIT_MAX} records at a time.`)
  .transform((ids) => [...new Set(ids.map((i) => i.toLowerCase()))]);

export const bulkEditSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    ids: bulkIdsSchema,
    field: z.string().min(1).max(80),
    value: z.unknown(),
  }),
  z.object({ op: z.literal("clear"), ids: bulkIdsSchema, field: z.string().min(1).max(80) }),
]);
export type BulkEditInput = z.input<typeof bulkEditSchema>;

export const bulkTagSchema = z
  .object({
    ids: bulkIdsSchema,
    add: z.array(uuid).max(BULK_TAGS_MAX).default([]),
    remove: z.array(uuid).max(BULK_TAGS_MAX).default([]),
  })
  .transform((v) => ({
    ids: v.ids,
    add: [...new Set(v.add.map((i) => i.toLowerCase()))],
    remove: [...new Set(v.remove.map((i) => i.toLowerCase()))],
  }))
  .refine((v) => v.add.length + v.remove.length > 0, "Choose a tag to add or remove.")
  .refine(
    (v) => !v.add.some((t) => v.remove.includes(t)),
    "A tag cannot be added and removed at once.",
  );
export type BulkTagInput = z.input<typeof bulkTagSchema>;

/**
 * Columns a person may change on many records at once: the columns a single edit may change, except the record's
 * title (giving many records the same name is never what was meant). Create-only and read-only columns are already
 * excluded by writableColumns.
 */
export function bulkEditableColumns(def: PortalObjectDef): PortalColumn[] {
  return writableColumns(def, "update").filter((c) => c.key !== def.titleColumn);
}

export type BulkEditPlan =
  { ok: true; ids: string[]; column: PortalColumn; value: unknown } | { ok: false; error: string };

/** Validates a bulk edit: a known editable field, a value that passes the field's own Zod rule, or a clear. */
export function planBulkEdit(def: PortalObjectDef, input: unknown): BulkEditPlan {
  const parsed = bulkEditSchema.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const p = parsed.data;
  const column = bulkEditableColumns(def).find((c) => c.key === p.field);
  if (!column) return { ok: false, error: "That field cannot be edited in bulk." };
  if (p.op === "clear") {
    if (column.required)
      return { ok: false, error: `${column.label} is required and cannot be cleared.` };
    return { ok: true, ids: p.ids, column, value: null };
  }
  if (p.value === undefined) return { ok: false, error: `Enter a value for ${column.label}.` };
  const res = columnSchema(column).safeParse(p.value);
  if (!res.success) {
    const msg = res.error.issues[0]?.message;
    return {
      ok: false,
      error:
        column.required && (p.value === null || p.value === "")
          ? `${column.label} is required`
          : (msg ?? `${column.label} is invalid`),
    };
  }
  // A blank value for an optional field validates to null: that is a clear, and must be asked for as one.
  if (res.data === null)
    return { ok: false, error: `Enter a value for ${column.label}, or choose Clear.` };
  return { ok: true, ids: p.ids, column, value: res.data };
}

export type BulkResult = { requested: number; updated: number; skipped: number };

/** Counts for the result toast: records changed, and records left alone (already had the value, or not found). */
export function bulkResult(requested: number, updated: number): BulkResult {
  const u = Math.max(0, Math.min(requested, updated));
  return { requested, updated: u, skipped: requested - u };
}

export function bulkResultMessage(r: BulkResult, noun = "record"): string {
  const plural = (n: number) => `${n.toLocaleString("en-GB")} ${noun}${n === 1 ? "" : "s"}`;
  if (r.updated === 0)
    return `No changes: ${plural(r.skipped)} already had that value or could not be found.`;
  return r.skipped > 0
    ? `Updated ${plural(r.updated)}; ${r.skipped.toLocaleString("en-GB")} skipped (already set or not found).`
    : `Updated ${plural(r.updated)}.`;
}

/** What to insert and delete to move a record from the tags it has to the tags wanted. */
export function diffTagSets(
  have: readonly string[],
  want: readonly string[],
): { add: string[]; remove: string[] } {
  const h = new Set(have);
  const w = new Set(want);
  return { add: [...w].filter((t) => !h.has(t)), remove: [...h].filter((t) => !w.has(t)) };
}

/** Rows to insert for a bulk "add tags": every (record, tag) pair the record does not have yet. */
export function tagRowsToAdd(
  ids: readonly string[],
  add: readonly string[],
  existing: ReadonlyArray<{ record_id: string; tag_id: string }>,
): Array<{ record_id: string; tag_id: string }> {
  const have = new Set(existing.map((e) => `${e.record_id}:${e.tag_id}`));
  const out: Array<{ record_id: string; tag_id: string }> = [];
  for (const record_id of ids)
    for (const tag_id of add)
      if (!have.has(`${record_id}:${tag_id}`)) out.push({ record_id, tag_id });
  return out;
}
