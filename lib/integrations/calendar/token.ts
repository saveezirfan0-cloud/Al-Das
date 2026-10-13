import { createHash, randomBytes } from "node:crypto";

/**
 * Calendar feed tokens (pure). 256 random bits, shown once, stored only as a SHA-256 hash. The "pcf_" prefix lets a secret
 * scanner recognise a leaked feed URL. The token is part of the URL path, so it never appears in an access log we write.
 */

export const FEED_TOKEN_PREFIX = "pcf_";
const FEED_TOKEN_RE = /^pcf_[A-Za-z0-9_-]{43}$/;

export function generateFeedToken(): string {
  return FEED_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function hashFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The token in a URL segment ("pcf_xxx" or "pcf_xxx.ics"), or null when it cannot be one. */
export function parseFeedToken(segment: string): string | null {
  const bare = segment.endsWith(".ics") ? segment.slice(0, -4) : segment;
  return FEED_TOKEN_RE.test(bare) ? bare : null;
}

export function feedUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/+$/, "")}/api/calendar/${token}.ics`;
}
