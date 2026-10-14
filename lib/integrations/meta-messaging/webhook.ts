import { hmac, safeEqual } from "@/lib/integrations/webhook";

import type { MessagingPlatform } from "./config";

/**
 * Inbound Instagram / Messenger webhooks (pure). Meta signs every POST with X-Hub-Signature-256: "sha256=" + hex HMAC-SHA256 of
 * the raw body with the app secret (the same scheme as the WhatsApp webhook). The subscription handshake is a GET with
 * hub.mode=subscribe, hub.verify_token and hub.challenge.
 *
 * Payload shape as documented (unverified against a live account):
 *   { "object": "page" | "instagram",
 *     "entry": [ { "id": "<page or IG account id>", "time": 1700000000000,
 *                  "messaging": [ { "sender": {"id": "<PSID / IGSID>"}, "recipient": {"id": "<page / IG id>"},
 *                                   "timestamp": 1700000000000,
 *                                   "message": { "mid": "...", "text": "...", "attachments": [...], "is_echo": true? } } ] } ] }
 * Only `message` events are used. Echoes of our own sends, reads, deliveries, reactions, postbacks and anything addressed to
 * another Page or account are ignored. Attachments are stored as "unsupported" without their link.
 */

export function verifyMetaMessagingSignature(
  raw: string,
  header: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !header) return false;
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m) return false;
  return safeEqual(hmac("sha256", appSecret, raw, "hex"), m[1].toLowerCase());
}

/** The challenge to echo when the handshake is ours, else null. The challenge is echoed only when it is a plain short token. */
export function handshakeChallenge(
  params: URLSearchParams,
  verifyToken: string | undefined,
): string | null {
  if (!verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const given = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge") ?? "";
  if (!/^[A-Za-z0-9_.-]{1,200}$/.test(challenge)) return null;
  return safeEqual(given, verifyToken) ? challenge : null;
}

export type MessagingEvent = {
  /** Idempotency key: platform + message id. */
  key: string;
  platform: MessagingPlatform;
  senderId: string;
  messageId: string;
  kind: "text" | "unsupported";
  text: string | null;
  at: Date;
};

const OBJECT_FOR: Record<MessagingPlatform, string> = { messenger: "page", instagram: "instagram" };

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Extracts inbound person-to-business messages addressed to `recipientId`. Throws on a body that is not JSON (the route answers
 * 400); silently skips anything it does not understand.
 */
export function parseMessagingEvents(
  platform: MessagingPlatform,
  raw: string,
  recipientId: string,
  now: Date = new Date(),
): MessagingEvent[] {
  const body = rec(JSON.parse(raw));
  if (!body || body.object !== OBJECT_FOR[platform] || !Array.isArray(body.entry)) return [];
  const out: MessagingEvent[] = [];
  for (const e of body.entry.slice(0, 50)) {
    const entry = rec(e);
    if (!entry || String(entry.id ?? "") !== recipientId || !Array.isArray(entry.messaging))
      continue;
    for (const m of entry.messaging.slice(0, 100)) {
      const ev = rec(m);
      const message = rec(ev?.message);
      if (!ev || !message) continue;
      if (message.is_echo === true || message.is_deleted === true) continue;
      const sender = String(rec(ev.sender)?.id ?? "");
      const recipient = String(rec(ev.recipient)?.id ?? "");
      const mid = typeof message.mid === "string" ? message.mid : "";
      if (!/^\d{1,40}$/.test(sender) || sender === recipientId || recipient !== recipientId)
        continue;
      if (!mid || mid.length > 300) continue;
      const text = typeof message.text === "string" && message.text.trim() ? message.text : null;
      const ts = Number(ev.timestamp);
      const at = Number.isFinite(ts) && ts > 0 && ts < now.getTime() + 300_000 ? new Date(ts) : now;
      out.push({
        key: `${platform}:${mid}`,
        platform,
        senderId: sender,
        messageId: mid,
        kind: text ? "text" : "unsupported",
        text: text ? text.slice(0, 4000) : null,
        at,
      });
    }
  }
  return out;
}
