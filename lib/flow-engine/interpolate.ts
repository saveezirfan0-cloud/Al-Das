/**
 * Message / field interpolation:
 *   {contact.first_name}
 *   {appointment.starts_at|date:"DD MMM HH:mm"}
 *   {vars.KEY|default:"there"}
 *   {steps.<node>.response.x}
 *
 * Unknown paths render as an empty string (reported by `missingPaths`, so a flow can be
 * validated before it messages a patient). Objects never render, so a mis-typed path cannot
 * dump a whole record into a WhatsApp message.
 */
import { formatInTimeZone } from "date-fns-tz";

export type Scope = Record<string, unknown>;

const TOKEN = /\{([A-Za-z_][\w.\-]*)((?:\|[a-z_]+(?::"[^"]*")?)*)\}/g;
const FILTER = /\|([a-z_]+)(?::"([^"]*)")?/g;

export function getPath(scope: Scope, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(part);
      if (!Number.isInteger(i)) return undefined;
      cur = cur[i];
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

/** Day.js-style tokens → date-fns patterns. Anything else is copied literally. */
const DATE_TOKENS: Array<[string, string]> = [
  ["YYYY", "yyyy"],
  ["MMMM", "MMMM"],
  ["dddd", "EEEE"],
  ["MMM", "MMM"],
  ["ddd", "EEE"],
  ["YY", "yy"],
  ["MM", "MM"],
  ["DD", "dd"],
  ["HH", "HH"],
  ["hh", "hh"],
  ["mm", "mm"],
  ["ss", "ss"],
  ["M", "M"],
  ["D", "d"],
  ["H", "H"],
  ["h", "h"],
  ["A", "a"],
];

export function toDateFnsPattern(pattern: string): string {
  let out = "";
  let literal = ""; // consecutive literal letters are quoted together ('at'), never one by one
  const flush = () => {
    if (literal) out += `'${literal.replace(/'/g, "''")}'`;
    literal = "";
  };
  let i = 0;
  while (i < pattern.length) {
    const hit = DATE_TOKENS.find(([tok]) => pattern.startsWith(tok, i));
    if (hit) {
      flush();
      out += hit[1];
      i += hit[0].length;
      continue;
    }
    const ch = pattern[i];
    if (/[A-Za-z]/.test(ch)) literal += ch;
    else {
      flush();
      out += ch === "'" ? "''" : ch;
    }
    i++;
  }
  flush();
  return out;
}

export function formatDate(value: unknown, pattern: string, timezone: string): string {
  if (value === null || value === undefined || value === "") return "";
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return formatInTimeZone(d, timezone, toDateFnsPattern(pattern));
  } catch {
    return "";
  }
}

export function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
    return String(value);
  return "";
}

function applyFilters(raw: unknown, filters: string, timezone: string): string {
  let current: unknown = raw;
  for (const m of filters.matchAll(FILTER)) {
    const [, name, arg] = m;
    switch (name) {
      case "date":
        current = formatDate(current, arg ?? "YYYY-MM-DD", timezone);
        break;
      case "upper":
        current = stringify(current).toUpperCase();
        break;
      case "lower":
        current = stringify(current).toLowerCase();
        break;
      case "default":
        current = stringify(current) === "" ? (arg ?? "") : current;
        break;
      case "trim":
        current = stringify(current).trim();
        break;
      default:
        break; // unknown filters are ignored (the validator reports them)
    }
  }
  return stringify(current);
}

export function interpolate(input: string, scope: Scope, opts: { timezone?: string } = {}): string {
  const tz = opts.timezone ?? "Asia/Dubai";
  return input.replace(TOKEN, (_m, path: string, filters: string) =>
    applyFilters(getPath(scope, path), filters ?? "", tz),
  );
}

/** Every {path} used in a string, with its filter names. */
export function references(input: string): Array<{ path: string; filters: string[] }> {
  const out: Array<{ path: string; filters: string[] }> = [];
  for (const m of input.matchAll(TOKEN)) {
    out.push({ path: m[1], filters: [...(m[2] ?? "").matchAll(FILTER)].map((f) => f[1]) });
  }
  return out;
}

export const KNOWN_FILTERS = new Set(["date", "upper", "lower", "default", "trim"]);
export const SCOPE_ROOTS = [
  "contact",
  "conversation",
  "message",
  "enquiry",
  "appointment",
  "task",
  "event",
  "vars",
  "steps",
] as const;

/** Paths that would render empty for this scope (used before sending and in tests). */
export function missingPaths(input: string, scope: Scope): string[] {
  return references(input)
    .filter((r) => stringify(getPath(scope, r.path)) === "" && !r.filters.includes("default"))
    .map((r) => r.path);
}
