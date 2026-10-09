/**
 * Pure value converters for Airtable → Postgres column values. Blank is NULL, never 0 or "".
 * No I/O; every function is unit-tested (tests/unit/airtable-convert.test.ts).
 */

export type Warn = (code: string) => void;

/** Airtable cell → trimmed string ('' when empty). Handles select objects and arrays. */
export function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as { name?: unknown; text?: unknown; value?: unknown };
    return toText(o.name ?? o.text ?? o.value ?? "");
  }
  return String(v).trim();
}

export function textOrNull(v: unknown): string | null {
  const s = toText(v);
  return s === "" ? null : s;
}

/** Numbers from Unite strings such as "36.5 C", "92", "1,234.50". Blank / non-numeric → null. */
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = toText(v).replace(/,/g, "");
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

export function toInt(v: unknown): number | null {
  const n = toNumber(v);
  return n === null ? null : Math.round(n);
}

/** Checkbox (true / undefined), "Yes"/"No", "true"/"false", 1/0. Absent → false unless `nullable`. */
export function toBool(v: unknown, nullable = false): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = toText(v).toLowerCase();
  if (["yes", "true", "y", "1", "checked"].includes(s)) return true;
  if (["no", "false", "n", "0"].includes(s)) return false;
  return nullable ? null : false;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

function validYmd(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** YYYY-MM-DD or null. Accepts ISO dates / timestamps and day-first D/M/YYYY (legacy Birthday rows). */
export function toDate(v: unknown): string | null {
  const s = toText(v);
  if (!s) return null;
  const iso = s.match(ISO_DATE);
  if (iso && validYmd(+iso[1], +iso[2], +iso[3])) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = s.match(DMY);
  if (dmy && validYmd(+dmy[3], +dmy[2], +dmy[1]))
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  return null;
}

/** ISO timestamp (UTC) or null. Airtable dateTime values are already ISO-8601 with a zone. */
export function toDateTime(v: unknown): string | null {
  const s = toText(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Lowercase snake key from a label: "GP / Adults" → "gp_adults". */
export function slug(v: unknown): string {
  return toText(v)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** "Other Services" / "OTHER SERVICES" / "Drugs" → OTHER_SERVICES / DRUGS. */
export function upperSnake(v: unknown): string | null {
  const s = slug(v);
  return s === "" ? null : s.toUpperCase();
}

/** Splits a combo such as "Corticosteroid + Antibiotic" into a trimmed array (null when empty). */
export function splitList(v: unknown, sep: RegExp | string = /\s*\+\s*/): string[] | null {
  const s = toText(v);
  if (!s) return null;
  const parts = s
    .split(sep)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

/** Unite sends "92/61" in a single BP field (R-01). Returns [systolic, diastolic], each nullable. */
export function parseBp(v: unknown): [number | null, number | null] {
  const s = toText(v);
  if (!s) return [null, null];
  const m = s.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
  if (m) return [Number(m[1]), Number(m[2])];
  return [toInt(s), null];
}

/** Values Airtable exports as column headers inside the data (Unite import artefacts). */
export function dropHeaderArtefact(v: unknown, header: string): string | null {
  const s = toText(v);
  if (!s || s.toUpperCase() === header.toUpperCase()) return null;
  return s;
}
