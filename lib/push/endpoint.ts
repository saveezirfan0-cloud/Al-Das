import { createHash } from "node:crypto";

import type { PushSubscriptionData } from "@/lib/push/types";

/**
 * The server POSTs to whatever endpoint a browser registers, so an endpoint is untrusted input (SSRF).
 * Only the push services that real browsers use are accepted: https, default port, no credentials.
 */
const ALLOWED_HOST_SUFFIXES = [
  "fcm.googleapis.com", // Chrome, Edge, Opera, Samsung Internet, Brave (via FCM)
  "push.services.mozilla.com", // Firefox (updates.push.services.mozilla.com)
  "notify.windows.com", // legacy Edge (WNS)
  "push.apple.com", // Safari / iOS web push (web.push.apple.com)
];

export function isAllowedPushEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

/** Shape-checks a subscription received from the browser. Returns null for anything unexpected. */
export function parseSubscription(input: unknown): PushSubscriptionData | null {
  if (!input || typeof input !== "object") return null;
  const o = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (
    typeof o.endpoint !== "string" ||
    o.endpoint.length > 1000 ||
    !isAllowedPushEndpoint(o.endpoint)
  )
    return null;
  const p256dh = o.keys?.p256dh;
  const auth = o.keys?.auth;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (p256dh.length < 80 || p256dh.length > 100 || !B64URL.test(p256dh)) return null;
  if (auth.length < 16 || auth.length > 32 || !B64URL.test(auth)) return null;
  return { endpoint: o.endpoint, keys: { p256dh, auth } };
}

/** A short topic for the push service: collapses repeated notifications about the same thing (max 32 chars). */
export function topicFor(tag: string): string {
  return createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}
