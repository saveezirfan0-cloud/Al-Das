/**
 * WhatsApp (Meta) Flow replies (Phase 20b, G2 `wa_flow_completed`). PURE.
 *
 * Meta delivers a submitted Flow form as an `interactive.nfm_reply` whose `response_json` is a JSON string of the form's
 * fields plus the `flow_token` it was sent with. The answers become run variables ({vars.form.<field>}), so they are capped
 * hard: a hostile or oversized form can never grow a run's context. Anything that is not a flat value is dropped.
 */

export const WA_FLOW_LIMITS = {
  /** Raw response_json, in characters, before parsing. Bigger replies are ignored entirely. */
  maxRawChars: 8_000,
  maxFields: 30,
  maxValueChars: 300,
} as const;

const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

export type WaFlowReply = { token: string | null; fields: Record<string, string> };

function flat(v: unknown): string | null {
  if (typeof v === "string") return v.trim().slice(0, WA_FLOW_LIMITS.maxValueChars);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) {
    const parts = v
      .slice(0, 20)
      .map((x) => (typeof x === "string" || typeof x === "number" ? String(x).trim() : null))
      .filter((x): x is string => !!x);
    return parts.length ? parts.join(", ").slice(0, WA_FLOW_LIMITS.maxValueChars) : null;
  }
  return null;
}

/** Reads `interactive.nfm_reply` out of a stored inbound message payload. Never throws; null when it is not a Flow reply. */
export function parseWaFlowReply(payload: unknown): WaFlowReply | null {
  if (!payload || typeof payload !== "object") return null;
  const interactive = (payload as Record<string, unknown>).interactive as
    Record<string, unknown> | undefined;
  if (!interactive || interactive.type !== "nfm_reply") return null;
  const nfm = interactive.nfm_reply as Record<string, unknown> | undefined;
  const raw = nfm?.response_json;
  if (typeof raw !== "string" || raw.length > WA_FLOW_LIMITS.maxRawChars)
    return { token: null, fields: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: null, fields: {} };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return { token: null, fields: {} };
  const obj = parsed as Record<string, unknown>;
  const token =
    typeof obj.flow_token === "string" && obj.flow_token.length <= 200 ? obj.flow_token : null;
  const fields: Record<string, string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "flow_token" || !FIELD_KEY.test(k)) continue;
    const value = flat(v);
    if (value === null) continue;
    fields[k] = value;
    if (++n >= WA_FLOW_LIMITS.maxFields) break;
  }
  return { token, fields };
}
