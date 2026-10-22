/**
 * Which value fills each {{n}} of a recall template (recall_programme_templates.variables_map, docs/49 D16).
 *
 * A stored value is one source path, optionally title-cased like Make's startcase, with an optional fallback:
 * "contact.first_name|title|default:Patient". The engine
 * renders it through renderValues (lib/recall/engine.ts), so the sources here are exactly the patient-facing
 * paths renderValues fills. Internal keys (recall.segment, recall.cycle) and the raw appointment start time are left
 * out on purpose: they would put a code or an ISO timestamp in a patient's message.
 */
import type { TemplateVariable } from "@/lib/whatsapp/templates";

export const RECALL_VARIABLE_SOURCES = [
  { key: "contact.first_name", label: "Patient: first name" },
  { key: "contact.last_name", label: "Patient: last name" },
  { key: "contact.full_name", label: "Patient: full name" },
  { key: "appointment.doctor_name", label: "Doctor's name" },
] as const;

export type RecallSource = (typeof RECALL_VARIABLE_SOURCES)[number]["key"];
export type RecallVariable = { source: RecallSource; fallback: string; title: boolean };

/** What the seed puts in {{1}} for chronic and birthday groups (Make's rule: first name in title case, else "Patient"). */
export const DEFAULT_RECALL_VARIABLE = "contact.first_name|title|default:Patient";

export const FALLBACK_MAX = 60;
const SOURCES: ReadonlySet<string> = new Set(RECALL_VARIABLE_SOURCES.map((s) => s.key));
const BODY_KEY = /^body\.[A-Za-z0-9_]+$/;
// The fallback sits inside {path|default:…}: braces, pipes and quotes would change how it is read.
const FALLBACK_OK = /^[^{}|"\r\n]*$/;

export function isRecallSource(value: string): value is RecallSource {
  return SOURCES.has(value);
}

/** Body variables of a template that a recall map must fill, in order (carousel cards and optional ones skipped). */
export function recallBodyKeys(vars: readonly TemplateVariable[]): string[] {
  return vars
    .filter((v) => v.component === "body" && v.card === undefined && !v.optional)
    .map((v) => v.key);
}

/** Reads a stored value back as source + fallback; null when it is not one the Recall page can edit. */
export function splitRecallVariable(expr: string | undefined | null): RecallVariable | null {
  if (!expr) return null;
  const [path, ...filters] = expr.split("|").map((s) => s.trim());
  if (!path || !isRecallSource(path)) return null;
  const out: RecallVariable = { source: path, fallback: "", title: false };
  let i = 0;
  if (filters[i] === "title") {
    out.title = true;
    i++;
  }
  if (i < filters.length) {
    const m = /^default:(.*)$/.exec(filters[i]!);
    if (!m) return null;
    out.fallback = m[1]!.trim();
    i++;
  }
  return i === filters.length ? out : null;
}

export function joinRecallVariable(v: RecallVariable): string {
  const fallback = v.fallback.trim();
  return `${v.source}${v.title ? "|title" : ""}${fallback ? `|default:${fallback}` : ""}`;
}

export type ParsedMap = { ok: true; map: Record<string, string> } | { ok: false; error: string };

/**
 * Validates what the Recall page sends. Keys must be body variables of the linked template; values must be a known
 * source and a plain fallback. Errors name the variable, never the typed text.
 */
export function parseRecallVariableMap(
  input: Record<string, { source: string; fallback?: string; title?: boolean }>,
  bodyKeys: readonly string[],
): ParsedMap {
  const allowed = new Set(bodyKeys);
  const map: Record<string, string> = {};
  for (const [key, v] of Object.entries(input)) {
    if (!BODY_KEY.test(key) || !allowed.has(key))
      return { ok: false, error: `This template has no variable ${label(key)}.` };
    if (!v.source) continue; // left blank: no value for this variable
    if (!isRecallSource(v.source))
      return { ok: false, error: `${label(key)} cannot be filled from that field.` };
    const fallback = (v.fallback ?? "").trim();
    if (fallback.length > FALLBACK_MAX)
      return {
        ok: false,
        error: `The fallback for ${label(key)} is longer than ${FALLBACK_MAX} characters.`,
      };
    if (!FALLBACK_OK.test(fallback))
      return {
        ok: false,
        error: `The fallback for ${label(key)} cannot contain braces, a | or quotation marks.`,
      };
    map[key] = joinRecallVariable({ source: v.source, fallback, title: v.title === true });
  }
  return { ok: true, map };
}

/** Body variables with no value: a send for this group would fail with "Missing template values". */
export function missingRecallVariables(
  bodyKeys: readonly string[],
  map: Record<string, string>,
): string[] {
  return bodyKeys.filter((k) => !map[k]);
}

/** "body.1" → "{{1}}" for messages and labels. */
export function label(key: string): string {
  return key.startsWith("body.") ? `{{${key.slice(5)}}}` : key;
}
