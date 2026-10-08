/**
 * Validation/coercion of custom field values against the org's definitions.
 * Values live in contacts.custom (jsonb) keyed by custom_fields.key.
 */
import { z } from "zod";

export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "boolean",
  "select",
  "multi_select",
  "url",
  "email",
  "phone",
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const customFieldOption = z.object({
  value: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(80),
});
export type CustomFieldOption = z.infer<typeof customFieldOption>;

export type CustomFieldDef = {
  key: string;
  label: string;
  type: CustomFieldType;
  options: CustomFieldOption[];
  required: boolean;
};

export type CoerceResult = { ok: true; value: unknown } | { ok: false; error: string };

const TRUE = new Set(["true", "yes", "y", "1", "on", "checked"]);
const FALSE = new Set(["false", "no", "n", "0", "off", "", "unchecked"]);

/**
 * Coerces a raw value (string from CSV/forms or a JSON value) into the stored
 * representation: string | number | boolean | string[] | null.
 * Blank input means null (never 0 / false) — CLAUDE.md rule 15.
 */
export function coerceCustomValue(def: CustomFieldDef, raw: unknown): CoerceResult {
  const blank = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
  if (blank)
    return def.required
      ? { ok: false, error: `${def.label} is required` }
      : { ok: true, value: null };

  switch (def.type) {
    case "text":
      return { ok: true, value: String(raw).trim().slice(0, 2000) };
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/,/g, "").trim());
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, error: `${def.label} must be a number` };
    }
    case "date": {
      const s = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).trim();
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : parseLooseDate(s);
      if (!iso) return { ok: false, error: `${def.label} must be a date (YYYY-MM-DD)` };
      return { ok: true, value: iso };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (TRUE.has(s)) return { ok: true, value: true };
      if (FALSE.has(s)) return { ok: true, value: false };
      return { ok: false, error: `${def.label} must be yes or no` };
    }
    case "select": {
      const s = String(raw).trim();
      const match = def.options.find(
        (o) => o.value === s || o.label.toLowerCase() === s.toLowerCase(),
      );
      return match
        ? { ok: true, value: match.value }
        : { ok: false, error: `${def.label}: "${s}" is not an option` };
    }
    case "multi_select": {
      const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[;,|]/);
      const values: string[] = [];
      for (const p of parts) {
        const s = p.trim();
        if (!s) continue;
        const match = def.options.find(
          (o) => o.value === s || o.label.toLowerCase() === s.toLowerCase(),
        );
        if (!match) return { ok: false, error: `${def.label}: "${s}" is not an option` };
        if (!values.includes(match.value)) values.push(match.value);
      }
      return { ok: true, value: values };
    }
    case "url": {
      const s = String(raw).trim();
      try {
        const u = new URL(s.includes("://") ? s : `https://${s}`);
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: `${def.label} must be a URL` };
      }
    }
    case "email": {
      const s = String(raw).trim().toLowerCase();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
        ? { ok: true, value: s }
        : { ok: false, error: `${def.label} must be an email` };
    }
    case "phone": {
      const s = String(raw).trim();
      return /^\+?[0-9 ()-]{6,20}$/.test(s)
        ? { ok: true, value: s }
        : { ok: false, error: `${def.label} must be a phone number` };
    }
  }
}

/** dd/mm/yyyy, dd-mm-yyyy, d.m.yyyy, yyyy/mm/dd → yyyy-mm-dd. European day-first (Dubai). */
export function parseLooseDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/.exec(t);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return build(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(t);
  if (m) return build(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function build(y: number, mo: number, d: number): string | null {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

/** Validates a whole custom object against the definitions; unknown keys are dropped. */
export function coerceCustomObject(
  defs: CustomFieldDef[],
  raw: Record<string, unknown> | null | undefined,
  opts: { partial?: boolean } = {},
): { ok: true; value: Record<string, unknown> } | { ok: false; errors: Record<string, string> } {
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const def of defs) {
    if (opts.partial && !(raw && def.key in raw)) continue;
    const res = coerceCustomValue(def, raw?.[def.key]);
    if (res.ok) {
      if (res.value !== null) out[def.key] = res.value;
    } else errors[def.key] = res.error;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value: out };
}

/** Human-readable value for grids and exports. */
export function formatCustomValue(def: CustomFieldDef, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  switch (def.type) {
    case "boolean":
      return value === true ? "Yes" : "No";
    case "select":
      return def.options.find((o) => o.value === value)?.label ?? String(value);
    case "multi_select":
      return (Array.isArray(value) ? value : [value])
        .map((v) => def.options.find((o) => o.value === v)?.label ?? String(v))
        .join(", ");
    default:
      return String(value);
  }
}
