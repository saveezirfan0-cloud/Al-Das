import type { Config } from "@/lib/integrations/types";

/**
 * Settings of the generic HTTP SMS gateway (Phase 20h, docs/30_PHASE_20H_SMS_MMLITE_NOTES.md). Pure: shared by the settings
 * action (extra validation), the readiness check and the adapter factory, so a value the form accepts is exactly a value the
 * adapter can use. The token or password is a secret field (integration_accounts.config_enc) and never passes through here.
 *
 * The request is deliberately small and fixed: POST to one https address, bearer or basic auth, and a flat body built from a
 * template of `name=value` pairs whose values are either a placeholder ({to}, {from}, {text}) or a short literal. Nothing else
 * about the patient or the appointment can be put into the request.
 */

export const HTTP_SMS_PLACEHOLDERS = ["to", "from", "text"] as const;
export type HttpSmsPlaceholder = (typeof HTTP_SMS_PLACEHOLDERS)[number];

export type BodyPart =
  | { key: string; kind: "placeholder"; name: HttpSmsPlaceholder }
  | { key: string; kind: "literal"; value: string };

export type HttpSmsConfig = {
  url: string;
  auth: "bearer" | "basic";
  username: string;
  encoding: "json" | "form";
  body: string;
  /** Dotted path of the provider's message id in a JSON answer ("id", "data.message_id"); empty = none. */
  idField: string;
  /** Optional read-only address on the same host for Test connection (a balance or account page). */
  testUrl: string;
};

const MAX_PAIRS = 12;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
const LITERAL = /^[A-Za-z0-9 _.:+-]{0,60}$/;
const ID_FIELD = /^[A-Za-z0-9_]{1,40}(\.[A-Za-z0-9_]{1,40}){0,2}$/;
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".arpa",
  ".lan",
  ".home",
  ".intranet",
];

export function readHttpSmsConfig(config: Config): HttpSmsConfig {
  const s = (k: string) => (typeof config[k] === "string" ? String(config[k]).trim() : "");
  return {
    url: s("http_url"),
    auth: s("http_auth") === "basic" ? "basic" : "bearer",
    username: s("http_username"),
    encoding: s("http_encoding") === "form" ? "form" : "json",
    body: s("http_body"),
    idField: s("http_id_field"),
    testUrl: s("http_test_url"),
  };
}

/**
 * Why a gateway address cannot be used (null = usable). https only, no credentials, no query string (keys belong in the
 * encrypted token field), the standard port, and a public-looking host name: no IP literal, no single-label or internal name.
 * The shared client then allows exactly this host and follows no redirect.
 */
export function gatewayUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "The gateway address must be a web address.";
  }
  if (u.protocol !== "https:") return "The gateway address must start with https://.";
  if (u.username || u.password)
    return "Put the user name and password in their own fields, not in the address.";
  if (u.search || u.hash)
    return "The gateway address cannot carry a query string; put the key in the token field.";
  if (u.port && u.port !== "443") return "The gateway address must use the standard https port.";
  const host = u.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s)) ||
    /^\[.*\]$/.test(host) ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    /^[0-9.]+$/.test(host)
  )
    return "The gateway address must use the provider's public host name, not an IP address or an internal name.";
  return null;
}

export type ParsedTemplate = { ok: true; parts: BodyPart[] } | { ok: false; error: string };

/** Parses `to={to}&sender={from}&message={text}` (pairs separated by & or new lines). */
export function parseBodyTemplate(text: string): ParsedTemplate {
  const pieces = text
    .split(/[&\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length === 0) return { ok: false, error: "The message body template is empty." };
  if (pieces.length > MAX_PAIRS)
    return { ok: false, error: `The message body template has more than ${MAX_PAIRS} fields.` };
  const parts: BodyPart[] = [];
  const seenKeys = new Set<string>();
  const used = new Map<HttpSmsPlaceholder, number>();
  for (const piece of pieces) {
    const eq = piece.indexOf("=");
    if (eq < 1) return { ok: false, error: "Write each field of the body template as name=value." };
    const key = piece.slice(0, eq).trim();
    const value = piece.slice(eq + 1).trim();
    if (!KEY.test(key))
      return {
        ok: false,
        error: "Field names in the body template use letters, digits, _ . or - only.",
      };
    if (seenKeys.has(key))
      return { ok: false, error: `The field ${key} appears twice in the body template.` };
    seenKeys.add(key);
    const ph = /^\{([a-z_]+)\}$/.exec(value);
    if (ph) {
      const name = ph[1] as HttpSmsPlaceholder;
      if (!(HTTP_SMS_PLACEHOLDERS as readonly string[]).includes(name))
        return { ok: false, error: "The body template may only use {to}, {from} and {text}." };
      used.set(name, (used.get(name) ?? 0) + 1);
      parts.push({ key, kind: "placeholder", name });
      continue;
    }
    if (/[{}]/.test(value))
      return {
        ok: false,
        error: "A placeholder must be the whole value, for example message={text}.",
      };
    if (!LITERAL.test(value))
      return {
        ok: false,
        error:
          "Fixed values in the body template are limited to 60 letters, digits, spaces and _ . : + -.",
      };
    parts.push({ key, kind: "literal", value });
  }
  if (used.get("to") !== 1 || used.get("text") !== 1)
    return { ok: false, error: "The body template must use {to} and {text} exactly once." };
  if ((used.get("from") ?? 0) > 1)
    return { ok: false, error: "The body template may use {from} only once." };
  return { ok: true, parts };
}

/** The serialised request body and its content type. Values are always strings; the template decides the field names. */
export function renderGatewayBody(
  parts: readonly BodyPart[],
  encoding: HttpSmsConfig["encoding"],
  values: Record<HttpSmsPlaceholder, string>,
): { body: string; contentType: string } {
  const pairs = parts.map(
    (p) => [p.key, p.kind === "placeholder" ? values[p.name] : p.value] as const,
  );
  if (encoding === "form") {
    const form = new URLSearchParams();
    for (const [k, v] of pairs) form.set(k, v);
    return { body: form.toString(), contentType: "application/x-www-form-urlencoded" };
  }
  return { body: JSON.stringify(Object.fromEntries(pairs)), contentType: "application/json" };
}

/** Everything wrong with a generic gateway's (non-secret) settings; empty = usable. */
export function httpSmsConfigProblems(cfg: HttpSmsConfig): string[] {
  const problems: string[] = [];
  if (!cfg.url) problems.push("Gateway address is missing.");
  else {
    const p = gatewayUrlProblem(cfg.url);
    if (p) problems.push(p);
  }
  if (cfg.auth === "basic" && !cfg.username) problems.push("Basic sign-in needs a user name.");
  const t = parseBodyTemplate(cfg.body);
  if (!t.ok) problems.push(t.error);
  if (cfg.idField && !ID_FIELD.test(cfg.idField))
    problems.push("The message id field is a JSON field name such as id or data.message_id.");
  if (cfg.testUrl) {
    const p = gatewayUrlProblem(cfg.testUrl);
    if (p) problems.push(`Check address: ${p}`);
    else if (
      cfg.url &&
      !gatewayUrlProblem(cfg.url) &&
      new URL(cfg.testUrl).hostname !== new URL(cfg.url).hostname
    )
      problems.push("The check address must be on the same host as the gateway address.");
  }
  return problems;
}

/** Reads a dotted path out of a parsed JSON answer; a string or a number is accepted as the id. */
export function readIdField(json: unknown, path: string): string | null {
  let cur: unknown = json;
  for (const seg of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (typeof cur === "string" && cur.trim()) return cur.trim().slice(0, 80);
  if (typeof cur === "number" && Number.isFinite(cur)) return String(cur);
  return null;
}
