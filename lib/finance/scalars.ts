/**
 * Lenient-but-strict scalar parsers shared by the Unite and Diligence mappers.
 * "invalid" means the value is present but unusable; null means blank. A blank
 * value never becomes 0, false or a date.
 */

export const blank = (v: unknown) =>
  v === null || v === undefined || (typeof v === "string" && v.trim() === "");

export function str(v: unknown): string | null {
  if (blank(v)) return null;
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

export function num(v: unknown): number | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : "invalid";
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return "invalid";
    return Number(cleaned);
  }
  return "invalid";
}

export function int(v: unknown): number | null | "invalid" {
  const n = num(v);
  if (n === null || n === "invalid") return n;
  return Number.isInteger(n) ? n : "invalid";
}

export function bool(v: unknown): boolean | null | "invalid" {
  if (blank(v)) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : "invalid";
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
  }
  return "invalid";
}

const pad = (n: number) => String(n).padStart(2, "0");

function validYmd(y: number, m: number, d: number): string | "invalid" {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d)
    return "invalid";
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * dd-MM-yyyy, dd/MM/yyyy, yyyy-MM-dd (optionally followed by a time), a JS Date (UTC parts),
 * or - only when `allowExcelSerial` is set - an Excel serial day number. Returns yyyy-MM-dd.
 */
export function date(
  v: unknown,
  opts: { allowExcelSerial?: boolean } = {},
): string | null | "invalid" {
  if (blank(v)) return null;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime())
      ? "invalid"
      : validYmd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  }
  if (typeof v === "number") {
    if (!opts.allowExcelSerial || !Number.isFinite(v) || v < 20_000 || v > 80_000) return "invalid";
    const ms = Math.round((v - 25_569) * 86_400_000); // 25569 = days from 1899-12-30 to 1970-01-01
    const dt = new Date(ms);
    return validYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (typeof v !== "string") return "invalid";
  const s = v.trim();
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})(?:[ T].*)?$/.exec(s);
  if (m) return validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s);
  if (m) return validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  return "invalid";
}
