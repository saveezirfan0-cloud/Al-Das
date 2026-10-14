import { redactText } from "@/lib/redact";

/**
 * What may leave Pulse in an error report (CLAUDE.md rules 9 and 10). Pure, with no Sentry import, so the browser, edge and
 * Node configs share it and unit tests can drive it with plain objects.
 *
 *   request      method, the URL without its query string or fragment, and an allow-list of headers; never the body,
 *                cookies, query string or environment
 *   user         the id only (Sentry never gets an e-mail, name or IP: sendDefaultPii is off as well)
 *   messages     exception values, messages and log entries pass through redactText (tokens, phone numbers, e-mails)
 *   breadcrumbs  UI breadcrumbs are dropped (their selectors can carry a patient's name from an aria-label); console
 *                breadcrumbs keep a redacted message and lose their arguments; URLs lose their query strings
 *   extra        dropped; tags and transaction names are redacted
 *   spans        descriptions and URL-like attributes lose their query strings (supabase-js puts filters such as a
 *                phone number in the query)
 */

/** Request headers that may be reported. Everything else (cookie, authorization, x-forwarded-for …) is dropped. */
export const SAFE_HEADERS: ReadonlySet<string> = new Set([
  "accept",
  "content-length",
  "content-type",
  "user-agent",
  "x-request-id",
  "x-vercel-id",
]);

const MESSAGE_MAX = 1000;
const URL_MAX = 500;

type Dict = Record<string, unknown>;

/** Drops the query string and fragment, then redacts what is left (a path can still hold a phone number). */
export function scrubUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const cut = url.search(/[?#]/);
  return redactText(cut === -1 ? url : url.slice(0, cut), URL_MAX);
}

/** Redacts free-form text; non-strings become undefined so nothing unexpected is passed on. */
export function scrubText(text: unknown, max = MESSAGE_MAX): string | undefined {
  return typeof text === "string" ? redactText(text, max) : undefined;
}

export function scrubHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Dict)) {
    if (SAFE_HEADERS.has(k.toLowerCase()) && typeof v === "string") out[k] = redactText(v, 300);
  }
  return out;
}

const URL_KEY = /url|uri|query|target|path|route|from|to|statement/i;

/** Scrubs a flat attribute bag (span data, breadcrumb data): URL-like keys lose their query, other strings are redacted. */
function scrubData(data: unknown): Dict | undefined {
  if (!data || typeof data !== "object") return undefined;
  const out: Dict = {};
  for (const [k, v] of Object.entries(data as Dict)) {
    if (typeof v === "string") out[k] = URL_KEY.test(k) ? scrubUrl(v) : redactText(v, 300);
    else if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    // Arrays and nested objects (console arguments, request bodies) are dropped.
  }
  return out;
}

export type ScrubbableBreadcrumb = {
  category?: string;
  message?: string;
  data?: Dict;
  [key: string]: unknown;
};

/** Returns null to drop the breadcrumb. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(crumb: T): T | null {
  const category = crumb.category ?? "";
  if (category.startsWith("ui.")) return null;
  const out = { ...crumb };
  if (out.message !== undefined) out.message = scrubText(out.message);
  if (category === "console") delete out.data;
  else if (out.data !== undefined) out.data = scrubData(out.data);
  return out;
}

type ExceptionValue = {
  value?: string;
  stacktrace?: { frames?: Array<Dict & { vars?: unknown; abs_path?: string }> };
  [key: string]: unknown;
};

type Span = { description?: string; data?: Dict; [key: string]: unknown };

export type ScrubbableEvent = {
  message?: unknown;
  logentry?: { message?: string; params?: unknown[] };
  exception?: { values?: ExceptionValue[] };
  request?: Dict;
  user?: Dict;
  breadcrumbs?: ScrubbableBreadcrumb[];
  extra?: Dict;
  tags?: Dict;
  transaction?: string;
  spans?: Span[];
  contexts?: Dict & { trace?: Dict; response?: Dict };
  [key: string]: unknown;
};

function scrubFrames(frames: Array<Dict & { vars?: unknown; abs_path?: string }> | undefined) {
  return frames?.map((f) => {
    const out = { ...f };
    delete out.vars;
    if (typeof out.abs_path === "string") out.abs_path = scrubUrl(out.abs_path);
    return out;
  });
}

function scrubSpan(span: Span): Span {
  const out = { ...span };
  // A span description is "GET https://host/path?query" or a route name: drop the query, redact the rest.
  if (typeof out.description === "string") out.description = scrubUrl(out.description);
  if (out.data) out.data = scrubData(out.data);
  return out;
}

/** beforeSend / beforeSendTransaction: returns a scrubbed copy (never the original object). */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const out: T = { ...event };

  if (out.request) {
    const r = out.request;
    out.request = {
      ...(typeof r.method === "string" ? { method: r.method } : {}),
      ...(typeof r.url === "string" ? { url: scrubUrl(r.url) } : {}),
      headers: scrubHeaders(r.headers) ?? {},
    };
  }

  if (out.user) {
    const id = out.user.id;
    if (typeof id === "string" || typeof id === "number") out.user = { id: String(id) };
    else delete out.user;
  }

  if (out.message !== undefined) out.message = scrubText(out.message);
  if (out.logentry) out.logentry = { message: scrubText(out.logentry.message) };

  if (out.exception?.values) {
    out.exception = {
      ...out.exception,
      values: out.exception.values.map((v) => ({
        ...v,
        ...(v.value !== undefined ? { value: scrubText(v.value) } : {}),
        ...(v.stacktrace
          ? { stacktrace: { ...v.stacktrace, frames: scrubFrames(v.stacktrace.frames) } }
          : {}),
      })),
    };
  }

  if (out.breadcrumbs) {
    out.breadcrumbs = out.breadcrumbs
      .map((b) => scrubBreadcrumb(b))
      .filter((b): b is ScrubbableBreadcrumb => b !== null);
  }

  delete out.extra;
  if (out.tags) out.tags = scrubData(out.tags);
  if (typeof out.transaction === "string") out.transaction = scrubUrl(out.transaction);
  if (out.spans) out.spans = out.spans.map(scrubSpan);

  if (out.contexts) {
    const contexts: Dict = { ...out.contexts };
    // The response context can carry set-cookie and other headers; keep the status only.
    const response = contexts.response as Dict | undefined;
    if (response)
      contexts.response =
        typeof response.status_code === "number" ? { status_code: response.status_code } : {};
    const trace = contexts.trace as Dict | undefined;
    if (trace?.data) contexts.trace = { ...trace, data: scrubData(trace.data) };
    out.contexts = contexts as T["contexts"];
  }

  return out;
}
