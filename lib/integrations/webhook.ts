import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Building blocks for verifying inbound provider webhooks (pure). Each provider adapter composes these into its own
 * `verify` function (Stripe, PayTabs and Twilio each sign differently); webhook-route.ts does the shared plumbing around them.
 */

/** Constant-time string comparison that does not leak the length either (both sides are hashed first). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function hmac(
  algorithm: "sha256" | "sha1",
  secret: string,
  data: string | Buffer,
  encoding: "hex" | "base64",
): string {
  return createHmac(algorithm, secret).update(data).digest(encoding);
}

/** Is a signed timestamp (epoch seconds) within `toleranceSec` of now, in either direction? Defeats replays of old captures. */
export function withinReplayWindow(tsSec: number, nowMs: number, toleranceSec = 300): boolean {
  if (!Number.isFinite(tsSec)) return false;
  return Math.abs(nowMs / 1000 - tsSec) <= toleranceSec;
}

/** A webhook body bigger than this is not from a payment or SMS provider. */
export const MAX_INTEGRATION_WEBHOOK_BYTES = 262_144;

/** Parses an application/x-www-form-urlencoded body into a flat object (last value wins). */
export function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}
