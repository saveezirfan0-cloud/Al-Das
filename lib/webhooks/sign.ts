import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhook signatures (Stripe-style, so receivers have a familiar pattern):
 *
 *   X-Pulse-Signature: t=<unix seconds>,v1=<hex hmac-sha256(secret, "<t>.<raw body>")>
 *
 * The timestamp is inside the signed string, so a captured request cannot be replayed with a new
 * timestamp; receivers should reject signatures older than a few minutes.
 */

export const SIGNATURE_HEADER = "X-Pulse-Signature";

export function signPayload(secret: string, body: string, timestampSeconds = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestampSeconds}.${body}`).digest("hex");
  return `t=${timestampSeconds},v1=${v1}`;
}

export function verifySignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolerance) return false;
  const expected = Buffer.from(signPayload(secret, body, t).split("v1=")[1], "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** whsec_<43 chars>: shown once when an endpoint is created or its secret rotated. */
export function generateWebhookSecret(): string {
  return `whsec_${Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
}
