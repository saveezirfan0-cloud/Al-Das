import { createHash, randomBytes } from "node:crypto";

export { API_KEY_SCOPES, hasScope, isApiKeyScope, SCOPE_LABELS, type ApiKeyScope } from "@/lib/public-api/scopes";

/**
 * API keys look like  pk_<8 chars>_<43 chars>  (about 256 bits of randomness in the secret part).
 * Only the SHA-256 of the whole key is stored, so a database leak does not leak usable keys, and the
 * key is shown exactly once. A fast hash is correct here: the secret is random, not a password.
 */

const KEY_RE = /^pk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const id = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(32).toString("base64url"); // 43 chars
  const key = `pk_${id}_${secret}`;
  return { key, prefix: `pk_${id}`, hash: hashApiKey(key) };
}

export function looksLikeApiKey(value: string): boolean {
  return KEY_RE.test(value);
}

/** "Bearer <token>" → token (case-insensitive scheme), or null. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
