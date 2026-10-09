/**
 * Template interpolation for flow text:
 *   {contact.first_name}
 *   {vars.KEY}                         workspace variables (enabled ones)
 *   {steps.<node>.response.x}          output of an earlier node
 *   {appointment.starts_at|date:"DD MMM HH:mm"}
 *   {contact.first_name|default:Patient}
 * Unknown paths render as an empty string and are reported in `missing` so the
 * run log can show them. Values are never logged here.
 */
import { formatInTimeZone } from "date-fns-tz";

export type InterpolateScope = Record<string, unknown>;
export type InterpolateResult = { text: string; missing: string[] };

const TOKEN = /\{([^{}]+)\}/g;

export function getPath(scope: unknown, path: string): unknown {
  let cur: unknown = scope;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** DD MMM HH:mm style tokens → date-fns-tz pattern. */
function toDateFnsPattern(fmt: string): string {
  return fmt
    .replace(/YYYY/g, "yyyy")
    .replace(/YY/g, "yy")
    .replace(/DD/g, "dd")
    .replace(/D/g, "d");
}

function applyFilter(value: unknown, filter: string, timezone: string): unknown {
  const idx = filter.indexOf(":");
  const name = (idx === -1 ? filter : filter.slice(0, idx)).trim();
  const arg = idx === -1 ? "" : filter.slice(idx + 1).trim();
  const unquoted = arg.replace(/^"(.*)"$/, "$1");
  switch (name) {
    case "default":
      return value === undefined || value === null || value === "" ? unquoted : value;
    case "upper":
      return String(value ?? "").toUpperCase();
    case "lower":
      return String(value ?? "").toLowerCase();
    case "date": {
      if (value === undefined || value === null || value === "") return "";
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) return "";
      return formatInTimeZone(d, timezone, toDateFnsPattern(unquoted || "dd MMM HH:mm"));
    }
    default:
      return value;
  }
}

export function interpolate(
  input: string,
  scope: InterpolateScope,
  opts: { timezone?: string } = {},
): InterpolateResult {
  const timezone = opts.timezone ?? "Asia/Dubai";
  const missing: string[] = [];
  const text = input.replace(TOKEN, (whole, raw: string) => {
    // Split on top-level pipes (not inside quotes).
    const parts: string[] = [];
    let buf = "";
    let quoted = false;
    for (const ch of raw) {
      if (ch === '"') quoted = !quoted;
      if (ch === "|" && !quoted) {
        parts.push(buf);
        buf = "";
      } else buf += ch;
    }
    parts.push(buf);
    const path = parts[0]!.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(path)) return whole; // not a token (e.g. JSON braces)
    let value = getPath(scope, path);
    const filters = parts.slice(1);
    if ((value === undefined || value === null) && !filters.some((f) => f.trim().startsWith("default"))) {
      missing.push(path);
      return "";
    }
    for (const f of filters) value = applyFilter(value, f, timezone);
    if (value === undefined || value === null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
  return { text, missing };
}
