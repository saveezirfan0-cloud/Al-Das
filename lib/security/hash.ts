import "server-only";

import { createHmac } from "node:crypto";

import { serverEnv } from "@/lib/env";

/**
 * Keyed hash for values we need to correlate but should not be able to read back (IP addresses, the
 * e-mail on a failed sign-in). HMAC-SHA256 with a server secret, so a database leak alone cannot be
 * reversed by hashing the IPv4 space. Truncated to 32 hex characters, plenty to correlate.
 */
export function hmacHash(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** The secret used for hmacHash: ENCRYPTION_KEY when set, else JOB_SECRET (always configured). */
export function hashSecret(): string {
  const env = serverEnv();
  return env.ENCRYPTION_KEY || env.JOB_SECRET;
}

export function hashValue(value: string): string {
  return hmacHash(value, hashSecret());
}
