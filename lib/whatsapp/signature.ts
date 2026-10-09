import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta signs every webhook POST: X-Hub-Signature-256: sha256=<hmac of the raw body with the app secret>.
 * Always verify over the raw bytes, never over a re-serialised JSON object.
 */
export function signMetaPayload(rawBody: string | Buffer, appSecret: string): string {
  return "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");
}

export function verifyMetaSignature(
  rawBody: string | Buffer,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const expected = Buffer.from(signMetaPayload(rawBody, appSecret));
  const provided = Buffer.from(header.trim());
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
