import "server-only";

import { clientIp } from "@/lib/rate-limit";
import { failedLoginAlert } from "@/lib/security/anomaly";
import { raiseAlert } from "@/lib/security/alerts";
import { hashValue } from "@/lib/security/hash";
import { readTokenClaims } from "@/lib/security/jwt";
import { readSecuritySettings } from "@/lib/security/settings";
import { uaFamily } from "@/lib/security/ua";
import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type AuthEventType =
  | "sign_in"
  | "sign_in_failed"
  | "sign_out"
  | "sign_out_everywhere"
  | "password_changed"
  | "mfa_enrolled"
  | "mfa_removed"
  | "mfa_verified"
  | "session_revoked";

type HeaderLike = Pick<Headers, "get">;

/** The org used for events that happen before an org is selected: the user's oldest active membership. */
async function firstOrgOf(admin: AdminClient, userId: string): Promise<string | null> {
  const { data } = await admin
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at")
    .limit(1);
  return data?.[0]?.org_id ?? null;
}

/** LIKE-escapes an e-mail so a failed-login lookup is an exact, case-insensitive match. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Writes an auth_events row. The raw IP is kept for 30 days (security_maintenance nulls it), its HMAC
 * and a coarse user-agent family stay. Never throws, never stores the password or the e-mail in clear.
 */
export async function recordAuthEvent(
  admin: AdminClient,
  input: {
    type: AuthEventType;
    userId?: string | null;
    orgId?: string | null;
    method?: "password" | "magic_link" | "mfa" | null;
    headers: HeaderLike;
    detail?: Record<string, Json>;
  },
): Promise<{ orgId: string | null }> {
  let orgId = input.orgId ?? null;
  try {
    if (!orgId && input.userId) orgId = await firstOrgOf(admin, input.userId);
    const ip = clientIp(input.headers);
    const known = ip !== "unknown";
    const { error } = await admin.from("auth_events").insert({
      org_id: orgId,
      user_id: input.userId ?? null,
      event_type: input.type,
      method: input.method ?? null,
      ip_hash: known ? hashValue(ip) : null,
      ip_address: known ? ip.slice(0, 64) : null,
      ua_family: uaFamily(input.headers.get("user-agent")),
      detail: input.detail ?? {},
    });
    if (error) console.error("[auth-events] insert failed", { type: input.type, code: error.code });
  } catch (err) {
    console.error("[auth-events] record threw", {
      type: input.type,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
  return { orgId };
}

/**
 * A failed password sign-in. The e-mail is stored only as a keyed hash. When it belongs to a member, the
 * event is attached to their org and the failures inside the window are counted; reaching the threshold
 * (five by default) raises one alert per window.
 */
export async function recordFailedSignIn(
  admin: AdminClient,
  input: { email: string; headers: HeaderLike },
): Promise<void> {
  try {
    const email = input.email.trim().toLowerCase();
    const emailHash = hashValue(email);
    const { data: profile } = await admin
      .from("profiles")
      .select("id")
      .ilike("email", likeEscape(email))
      .limit(1);
    const userId = profile?.[0]?.id ?? null;
    const orgId = userId ? await firstOrgOf(admin, userId) : null;

    const ip = clientIp(input.headers);
    const known = ip !== "unknown";
    const now = new Date();
    const { error } = await admin.from("auth_events").insert({
      org_id: orgId,
      user_id: userId,
      event_type: "sign_in_failed",
      method: "password",
      ip_hash: known ? hashValue(ip) : null,
      ip_address: known ? ip.slice(0, 64) : null,
      ua_family: uaFamily(input.headers.get("user-agent")),
      email_hash: emailHash,
      detail: {},
    });
    if (error) {
      console.error("[auth-events] failed-sign-in insert failed", { code: error.code });
      return;
    }
    if (!orgId) return; // unknown e-mail: nobody to alert, and the rate limiter already throttles it

    const { data: org } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
    const settings = readSecuritySettings(org?.settings);
    const since = new Date(
      now.getTime() - settings.failed_login_window_minutes * 60_000,
    ).toISOString();
    const { count } = await admin
      .from("auth_events")
      .select("id", { count: "exact", head: true })
      .eq("event_type", "sign_in_failed")
      .eq("email_hash", emailHash)
      .gte("at", since);
    const draft = failedLoginAlert(
      { subjectKey: emailHash, userId, failures: count ?? 0, now },
      settings,
    );
    if (draft) await raiseAlert(admin, orgId, draft);
  } catch (err) {
    console.error("[auth-events] recordFailedSignIn threw", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** A successful sign-in: the auth event plus the device row for the session list. */
export async function recordSignIn(
  admin: AdminClient,
  input: {
    userId: string;
    accessToken: string | null;
    method: "password" | "magic_link" | "mfa";
    headers: HeaderLike;
  },
): Promise<void> {
  const { orgId } = await recordAuthEvent(admin, {
    type: "sign_in",
    userId: input.userId,
    method: input.method,
    headers: input.headers,
  });
  if (orgId)
    await trackSession(admin, {
      orgId,
      userId: input.userId,
      accessToken: input.accessToken,
      headers: input.headers,
    });
}

/** Upserts the device row for the current session (keyed on the GoTrue session id). */
export async function trackSession(
  admin: AdminClient,
  input: { orgId: string; userId: string; accessToken: string | null; headers: HeaderLike },
): Promise<void> {
  try {
    const { sessionId } = readTokenClaims(input.accessToken);
    if (!sessionId) return;
    const ip = clientIp(input.headers);
    const now = new Date().toISOString();
    const row = {
      org_id: input.orgId,
      user_id: input.userId,
      session_id: sessionId,
      ip_hash: ip !== "unknown" ? hashValue(ip) : null,
      ua_family: uaFamily(input.headers.get("user-agent")),
    };
    // Insert once; afterwards only bump last_seen_at. A revoked session is never revived.
    const { error: insertError } = await admin
      .from("user_sessions")
      .upsert(row, { onConflict: "user_id,session_id", ignoreDuplicates: true });
    const { error: touchError } = await admin
      .from("user_sessions")
      .update({ last_seen_at: now })
      .eq("user_id", input.userId)
      .eq("session_id", sessionId)
      .is("revoked_at", null);
    const error = insertError ?? touchError;
    if (error) console.error("[auth-events] session upsert failed", { code: error.code });
  } catch (err) {
    console.error("[auth-events] trackSession threw", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
