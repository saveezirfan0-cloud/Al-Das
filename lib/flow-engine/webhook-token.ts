import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Incoming-webhook flows authenticate with a bearer token; only its SHA-256 is stored on the flow. */
export function newWebhookToken(): { token: string; hash: string } {
  const token = `pfw_${randomBytes(24).toString("base64url")}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(presented: string | null | undefined, storedHash: unknown): boolean {
  if (!presented || typeof storedHash !== "string" || storedHash.length !== 64) return false;
  const a = Buffer.from(hashToken(presented), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
