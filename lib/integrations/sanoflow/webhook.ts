import { createHash } from "node:crypto";

import { safeEqual } from "@/lib/integrations/webhook";
import { toE164 } from "@/lib/whatsapp/phone";

/**
 * Sanoflow's "patient replied / booked" call (pure). Replaces Make's "Chronic Update" webhook (docs/audit/make-raw/
 * 5916036_Chronic_Update.summary.md): a Sanoflow flow's API Action node posts {"Mobile": "+9715…", "Status": "Replied" |
 * "Booked", "Trigger Data": "…"}. Keys are read case-insensitively; `phone` is accepted for `Mobile`. Nothing else in the body is
 * read or kept.
 *
 * Sanoflow does not sign its calls, so the flow sends the token typed under Settings, Integrations, Sanoflow in the
 * `x-pulse-token` header (or `?token=` when the node cannot set headers). It is compared in constant time; without a stored
 * token every call is refused.
 */
export type SanoflowStatusEvent = { phone: string; status: "replied" | "booked" };

export function verifySanoflowToken(
  headers: Headers,
  search: string,
  stored: string | undefined,
): boolean {
  if (!stored || stored.length < 32) return false;
  const given = headers.get("x-pulse-token") ?? new URLSearchParams(search).get("token") ?? "";
  if (!given) return false;
  return safeEqual(given, stored);
}

function field(o: Record<string, unknown>, names: readonly string[]): unknown {
  for (const [k, v] of Object.entries(o)) if (names.includes(k.toLowerCase())) return v;
  return undefined;
}

/** The status call, or null when it is not one Pulse understands (unknown status, no usable phone). */
export function parseSanoflowStatus(raw: string): SanoflowStatusEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, unknown>;
  const status = String(field(o, ["status"]) ?? "")
    .trim()
    .toLowerCase();
  if (status !== "replied" && status !== "booked") return null;
  const mobile = field(o, ["mobile", "phone"]);
  const phone =
    typeof mobile === "string" || typeof mobile === "number" ? toE164(String(mobile)) : null;
  if (!phone) return null;
  return { phone, status };
}

/**
 * The idempotency key: the body's hash and the day. A provider that delivers the same call twice acts once; the same patient
 * replying again on another day is a new event (the attribution itself only fills empty dates, so a repeat changes nothing).
 */
export function sanoflowEventKey(raw: string, nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return `status:${day}:${createHash("sha256").update(raw, "utf8").digest("hex")}`;
}
