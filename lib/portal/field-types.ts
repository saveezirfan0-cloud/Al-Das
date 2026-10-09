import { z } from "zod";

import type { PortalColumn, PortalObjectDef } from "@/lib/portal/types";
import { SYSTEM_COLUMNS } from "@/lib/portal/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Every column the object exposes, in display order (own columns, then system columns). */
export function allColumns(def: PortalObjectDef): PortalColumn[] {
  return [...def.columns, ...SYSTEM_COLUMNS];
}

export function writableColumns(def: PortalObjectDef, mode: "create" | "update"): PortalColumn[] {
  return def.columns.filter((c) => !c.readOnly && (mode === "create" || !c.createOnly));
}

/** Zod schema for one column's incoming value. Blank strings become null (or fail if required). */
export function columnSchema(col: PortalColumn): z.ZodType<unknown> {
  const blankToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);
  let base: z.ZodType<unknown>;
  switch (col.type) {
    case "text":
    case "long_text": {
      let s = z.string().trim();
      if (col.maxLength) s = s.max(col.maxLength, `${col.label} is too long`);
      base = s;
      break;
    }
    case "url":
      base = z.string().trim().url(`${col.label} must be a valid URL`).max(2000);
      break;
    case "email":
      base = z.string().trim().email(`${col.label} must be a valid email`).max(320);
      break;
    case "number": {
      const n = z.preprocess(
        (v) => (typeof v === "string" ? Number(v) : v),
        col.integer
          ? z
              .number({ error: `${col.label} must be a number` })
              .int(`${col.label} must be a whole number`)
          : z.number({ error: `${col.label} must be a number` }).finite(),
      );
      base = n;
      break;
    }
    case "boolean":
      base = z.boolean({ error: `${col.label} must be yes or no` });
      break;
    case "date":
      base = z.string().trim().refine(isRealDate, `${col.label} must be a date (YYYY-MM-DD)`);
      break;
    case "datetime":
      base = z
        .string()
        .trim()
        .refine((s) => !Number.isNaN(Date.parse(s)), `${col.label} must be a date and time`);
      break;
    case "select": {
      const values = (col.options ?? []).map((o) => o.value);
      base = z.string().refine((v) => values.includes(v), `${col.label} has an unknown option`);
      break;
    }
    case "multi_select": {
      const values = col.options?.map((o) => o.value);
      base = z
        .array(z.string().trim().min(1).max(200))
        .max(100)
        .refine(
          (arr) => !values || arr.every((v) => values.includes(v)),
          `${col.label} has an unknown option`,
        );
      break;
    }
    case "link":
      base = z.string().uuid(`${col.label} must be a valid record`);
      break;
  }
  if (col.required) {
    return z.preprocess(blankToNull, base);
  }
  // Optional: null / undefined / blank are all "clear this value" (null).
  return z.preprocess(blankToNull, base.nullable());
}

export type PortalInputResult =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string; fieldErrors: Record<string, string> };

/**
 * Validates a create / update payload against the object's writable columns.
 * - create: required columns must be present; absent optional columns are omitted.
 * - update: only keys present in the payload are validated and returned.
 * Unknown and read-only keys are dropped (never written).
 */
export function parsePortalInput(
  def: PortalObjectDef,
  mode: "create" | "update",
  input: unknown,
): PortalInputResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "Invalid input", fieldErrors: {} };
  }
  const src = input as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  const fieldErrors: Record<string, string> = {};
  for (const col of writableColumns(def, mode)) {
    const present =
      Object.prototype.hasOwnProperty.call(src, col.key) && src[col.key] !== undefined;
    if (!present) {
      if (mode === "create" && col.required) fieldErrors[col.key] = `${col.label} is required`;
      continue;
    }
    const res = columnSchema(col).safeParse(src[col.key]);
    if (!res.success) {
      const msg = res.error.issues[0]?.message;
      fieldErrors[col.key] =
        col.required && (src[col.key] === null || src[col.key] === "" || msg === undefined)
          ? `${col.label} is required`
          : (msg ?? `${col.label} is invalid`);
      continue;
    }
    values[col.key] = res.data;
  }
  const first = Object.values(fieldErrors)[0];
  if (first) return { ok: false, error: first, fieldErrors };
  return { ok: true, values };
}

/** Plain-text rendering of a cell value for CSV export and fallbacks. */
export function displayValue(col: PortalColumn, value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (col.type) {
    case "boolean":
      return value ? "Yes" : "No";
    case "select": {
      const o = col.options?.find((x) => x.value === value);
      return o?.label ?? String(value);
    }
    case "multi_select":
      return Array.isArray(value) ? value.join("; ") : String(value);
    default:
      return String(value);
  }
}

/** Maps a Postgres error from a portal write to a message safe to show staff. */
export function friendlyDbError(err: { code?: string; message?: string }): string {
  switch (err.code) {
    case "23505":
      return "A record with the same unique value already exists.";
    case "23503":
      return "This record is linked to other data, or the linked record does not exist.";
    case "23514":
      return err.message?.includes("approved_requires_signature")
        ? "An approved setting needs an approved value, a signer and a signature date."
        : err.message?.includes("heuristic_is_unclassified")
          ? "A heuristic suggestion cannot be an effective classification."
          : "The values do not satisfy a database rule.";
    case "23502":
      return "A required value is missing.";
    default:
      return "Could not save the record.";
  }
}
