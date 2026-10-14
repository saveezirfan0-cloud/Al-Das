import { createHash, randomBytes } from "node:crypto";

import { GOOGLE_AUTH_URL, GOOGLE_SCOPES } from "./config";

/**
 * OAuth "state" handling for connecting a specialist's Google Calendar (pure). The state is 256 random bits, kept by the browser
 * only in the redirect; the database keeps its SHA-256 with the person, the specialist and a 10 minute expiry, and it works once.
 */
export const STATE_TTL_MS = 10 * 60 * 1000;

export function newOAuthState(): { state: string; hash: string } {
  const state = randomBytes(32).toString("base64url");
  return { state, hash: hashOAuthState(state) };
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function isStateShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function buildAuthUrl(a: { clientId: string; redirectUri: string; state: string }): string {
  const u = new URL(GOOGLE_AUTH_URL);
  u.searchParams.set("client_id", a.clientId);
  u.searchParams.set("redirect_uri", a.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  // A refresh token is needed for the background sync; "consent" makes Google issue it again on a reconnect.
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("state", a.state);
  return u.toString();
}

export type StateRow = {
  org_id: string;
  user_id: string;
  specialist_id: string;
  expires_at: string;
  used_at: string | null;
};

export type StateDecision = "ok" | "unknown" | "expired" | "used" | "wrong_person";

/** Whether a returned state may complete the connection for the person who is signed in now. */
export function stateDecision(
  row: StateRow | null,
  who: { orgId: string; userId: string },
  now: Date = new Date(),
): StateDecision {
  if (!row) return "unknown";
  if (row.used_at) return "used";
  if (row.org_id !== who.orgId || row.user_id !== who.userId) return "wrong_person";
  if (Date.parse(row.expires_at) <= now.getTime()) return "expired";
  return "ok";
}

/** Google's answer on the callback: an authorisation code, or an error such as access_denied. */
export function readCallback(
  params: URLSearchParams,
): { ok: true; code: string; state: string } | { ok: false; reason: "denied" | "invalid" } {
  const state = params.get("state");
  if (params.get("error")) return { ok: false, reason: "denied" };
  const code = params.get("code");
  if (!isStateShape(state) || !code || code.length > 512 || /[\s\u0000-\u001f]/.test(code))
    return { ok: false, reason: "invalid" };
  return { ok: true, code, state };
}
