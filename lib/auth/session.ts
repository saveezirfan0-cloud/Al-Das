import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { assertCan, can, ForbiddenError, type MemberLike } from "@/lib/auth/can";
import { parseEnquiryScope } from "@/lib/enquiries/scope";
import { requestClientIp, type ParsedIp } from "@/lib/security/client-ip";
import {
  financeAccessDecision,
  isFinancePath,
  readFinanceAccess,
  restrictedAreasFor,
  type FinanceAccessDecision,
} from "@/lib/security/finance-access";
import { AUTH_MODE_HEADER, isAuthMode, REQUEST_PATH_HEADER } from "@/lib/supabase/auth-mode";
import { redactText } from "@/lib/redact";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/types";

export const ORG_COOKIE = "pulse_org";

/** The membership lookup itself failed (database error), as opposed to the user having no workspace. */
export class MemberLookupError extends Error {
  constructor() {
    super("Could not load your workspace membership");
    this.name = "MemberLookupError";
  }
}

export function isMemberLookupError(e: unknown): boolean {
  return e instanceof Error && e.name === "MemberLookupError";
}

export type CurrentMember = MemberLike & {
  membershipId: string;
  user: User;
  profile: Tables<"profiles">;
  org: Tables<"orgs">;
  presence: "online" | "away" | "offline";
  /** Phase 20c: restricted enquiry view (memberships.enquiry_scope); lib/enquiries/visibility.ts reads it. */
  enquiryScope?: "all" | "team" | "own";
  roleName: string;
  /**
   * The finance access window for this request (lib/security/finance-access.ts). When it denies, `restrictedAreas`
   * holds "finance" and "accounting", so every can() for those keys is false; everything else is unchanged.
   */
  financeAccess: FinanceAccessDecision;
  /** The request's client address (platform headers), parsed; null when unknown. Never logged in full. */
  clientIp: ParsedIp | null;
  /** Other orgs the user belongs to (for the org switcher). */
  orgs: Array<{ id: string; name: string; slug: string }>;
};

/** The client address from the platform headers (null outside a request or when missing). */
async function requestIp(): Promise<ParsedIp | null> {
  try {
    return requestClientIp(await headers());
  } catch {
    return null;
  }
}

/** The path the middleware forwarded (null outside a request). */
async function requestPath(): Promise<string | null> {
  try {
    return (await headers()).get(REQUEST_PATH_HEADER);
  } catch {
    return null;
  }
}

/** Member objects whose refusal is already recorded (one object per render; the alert is deduped per day anyway). */
const refusalsRecorded = new WeakSet<object>();

/** Raises the finance access security alert for this member, at most once per request (the alert itself is per day). */
async function recordFinanceRefusal(member: CurrentMember): Promise<void> {
  if (member.financeAccess?.allowed !== false || refusalsRecorded.has(member)) return;
  refusalsRecorded.add(member);
  const { noteFinanceDenial } = await import("@/lib/security/finance-access-server");
  await noteFinanceDenial(member);
}

/** True for a server action request (Next sends the action id in this header). */
async function isServerAction(): Promise<boolean> {
  try {
    return (await headers()).has("next-action");
  } catch {
    return false;
  }
}

/** The mode the middleware chose for this request ("strict" when unknown: scripts, tests, or no middleware). */
async function requestAuthMode() {
  try {
    const value = (await headers()).get(AUTH_MODE_HEADER);
    return isAuthMode(value) ? value : "strict";
  } catch {
    return "strict";
  }
}

/** Builds the few User fields the app reads from verified token claims. */
function userFromClaims(claims: {
  sub: string;
  aud?: string | string[];
  email?: string;
  phone?: string;
  app_metadata?: Record<string, unknown>;
  user_metadata?: Record<string, unknown>;
  iat?: number;
}): User {
  return {
    id: claims.sub,
    aud: Array.isArray(claims.aud)
      ? (claims.aud[0] ?? "authenticated")
      : (claims.aud ?? "authenticated"),
    email: claims.email,
    phone: claims.phone ?? "",
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
    created_at: claims.iat ? new Date(claims.iat * 1000).toISOString() : new Date(0).toISOString(),
  } as User;
}

/**
 * The signed-in auth user, or null. Cached per request.
 * Page navigations (middleware mode "claims") use the locally verified token claims; server actions and other
 * mutating requests ("strict") ask Supabase Auth, which also notices a revoked session.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  if ((await requestAuthMode()) === "claims") {
    const { data } = await supabase.auth.getClaims();
    return data?.claims?.sub ? userFromClaims(data.claims) : null;
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/**
 * The signed-in user's membership in the current org (cookie-selected, else the
 * first active one). Null when signed out or without a membership; throws MemberLookupError when the lookup fails.
 * Reads go through the user's own client so RLS applies.
 */
export const getCurrentMember = cache(async (): Promise<CurrentMember | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data: memberships, error } = await supabase
    .from("memberships")
    .select(
      "id, org_id, role_id, status, presence, enquiry_scope, roles(name, permissions), orgs(*)",
    )
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at");

  // A failed lookup is not "no workspace": treating it as one sent members to /onboarding and let them create a
  // duplicate workspace (e.g. when a migration the query needs had not been applied yet).
  if (error) {
    console.error("[auth] membership lookup failed", {
      code: error.code,
      message: redactText(error.message),
    });
    throw new MemberLookupError();
  }
  if (!memberships || memberships.length === 0) return null;

  const cookieStore = await cookies();
  const preferred = cookieStore.get(ORG_COOKIE)?.value;
  const membership = memberships.find((m) => m.org_id === preferred) ?? memberships[0];
  const role = membership.roles;
  const org = membership.orgs;
  if (!role || !org) return null;

  const { data: profile } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  if (!profile) return null;

  const permissions = Array.isArray(role.permissions)
    ? (role.permissions as unknown[]).filter((p): p is string => typeof p === "string")
    : [];

  // Finance access window: decided once per request from the org row already loaded above (no extra query).
  const clientIp = await requestIp();
  const financeAccess = financeAccessDecision({
    now: new Date(),
    timezone: org.timezone,
    stored: readFinanceAccess(org.settings),
    ip: clientIp,
    member: { roleId: membership.role_id, permissions },
  });

  const current: CurrentMember = {
    userId: user.id,
    orgId: membership.org_id,
    roleId: membership.role_id,
    roleName: role.name,
    membershipId: membership.id,
    status: membership.status as "active" | "suspended",
    presence: membership.presence as "online" | "away" | "offline",
    enquiryScope: parseEnquiryScope(membership.enquiry_scope),
    permissions,
    restrictedAreas: restrictedAreasFor(financeAccess),
    financeAccess,
    clientIp,
    user,
    profile,
    org,
    orgs: memberships
      .map((m) => m.orgs)
      .filter((o): o is NonNullable<typeof o> => !!o)
      .map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
  };
  // A refusal on a finance or accounting page, action or API route is an access attempt: record it here, once, so
  // every gate (requirePerm, the module gate() helpers, route handlers using can()) is covered without changes.
  if (!financeAccess.allowed && isFinancePath(await requestPath()))
    await recordFinanceRefusal(current);
  return current;
});

/** Best effort, for sign-out and auth-event logging: a failed lookup counts as no membership, never as an error. */
export async function getCurrentMemberIfAvailable(): Promise<CurrentMember | null> {
  try {
    return await getCurrentMember();
  } catch (e) {
    if (isMemberLookupError(e)) return null;
    throw e;
  }
}

/** Redirects to /login (signed out) or /onboarding (no workspace). */
export async function requireMember(): Promise<CurrentMember> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const member = await getCurrentMember();
  if (!member) redirect("/onboarding");
  return member;
}

/** Where a page navigation lands when the finance access window refuses it. Outside /finance and /accounting. */
export const FINANCE_UNAVAILABLE_PATH = "/finance-unavailable";

/** True when the role grants the permission but the finance access window takes it away for this request. */
export function blockedByFinanceWindow(member: CurrentMember, permission: string): boolean {
  return (
    member.financeAccess?.allowed === false &&
    !can(member, permission) &&
    can({ ...member, restrictedAreas: [] }, permission)
  );
}

/**
 * Records the refusal (one security alert per member per day) and sends a page navigation to the explanation page.
 * Server actions get a ForbiddenError instead, which they already turn into an error message.
 */
export async function refuseOutsideFinanceWindow(
  member: CurrentMember,
  permission: string,
): Promise<never> {
  await recordFinanceRefusal(member);
  if (await isServerAction()) throw new ForbiddenError(permission);
  redirect(FINANCE_UNAVAILABLE_PATH);
}

/**
 * For the finance and accounting layouts: a member the window refuses is recorded and sent to the explanation page,
 * whichever page of the module they asked for. Pages still check their own permission (requirePerm), because a layout
 * is not re-rendered on every client-side navigation.
 */
export async function enforceFinanceWindow(member: CurrentMember): Promise<void> {
  if (member.financeAccess?.allowed !== false) return;
  await recordFinanceRefusal(member);
  redirect(FINANCE_UNAVAILABLE_PATH);
}

/** requireMember() plus a permission check; throws ForbiddenError when missing. */
export async function requirePerm(permission: string): Promise<CurrentMember> {
  const member = await requireMember();
  if (blockedByFinanceWindow(member, permission))
    await refuseOutsideFinanceWindow(member, permission);
  assertCan(member, permission);
  return member;
}
