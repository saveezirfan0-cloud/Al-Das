/**
 * What leaves the platform in a webhook. Payloads are PHI-minimal by construction: only identifiers
 * and a short allowlist of non-identifying scalars survive, whatever the emitter passed. Receivers
 * fetch details through the public API with the ids.
 */

/**
 * An ALLOWLIST, not a pattern: a key like `wa_id` (a phone number) or `external_id` (a patient PIN)
 * also "ends in _id", so matching on the name's shape would leak identifiers. Add a key here only
 * when its value is an opaque internal id or a non-identifying enum.
 */
const ID_KEYS = new Set([
  "conversation_id",
  "message_id",
  "contact_id",
  "channel_id",
  "template_id",
  "category_id",
  "team_id",
  "user_id",
  "flow_run_id",
  "campaign_id",
  "enquiry_id",
  "appointment_id",
]);
const SAFE_SCALAR_KEYS = new Set(["status", "direction", "kind", "auto", "by", "category", "quality", "via", "source", "code", "event", "limit"]);

export function sanitizePayload(payload: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(payload)) {
    const isId = ID_KEYS.has(key);
    if (!isId && !SAFE_SCALAR_KEYS.has(key)) continue;
    if (value === null && isId) out[key] = null;
    else if (typeof value === "string") {
      // Identifiers and enum-like words only: anything long or with spaces is neither.
      if (value.length <= 64 && !/\s/.test(value)) out[key] = value;
    } else if (!isId && (typeof value === "boolean" || typeof value === "number")) out[key] = value;
  }
  return out;
}

export type Envelope = {
  id: string;
  type: string;
  created_at: string;
  org_id: string;
  data: Record<string, string | number | boolean | null>;
};

export function buildEnvelope(input: { id: string; type: string; orgId: string; createdAt: Date; payload: Record<string, unknown> }): Envelope {
  return {
    id: input.id,
    type: input.type,
    created_at: input.createdAt.toISOString(),
    org_id: input.orgId,
    data: sanitizePayload(input.payload),
  };
}
