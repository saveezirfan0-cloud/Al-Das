import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { assertCan, type MemberLike } from "@/lib/auth/can";
import { parseBranchScope, type BranchScope } from "@/lib/branches/access";
import { parseEnquiryScope } from "@/lib/enquiries/scope";
import { AUTH_MODE_HEADER, isAuthMode } from "@/lib/supabase/auth-mode";
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
  /** Phase B branch access (lib/branches/access.ts): 'all' or the chosen branches, plus the home branch. */
  branchScope?: BranchScope;
  branchIds?: string[];
  homeLocationId?: string | null;
  roleName: string;
  /** Other orgs the user belongs to (for the org switcher). */
  orgs: Array<{ id: string; name: string; slug: string }>;
};

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
      "id, org_id, role_id, status, presence, enquiry_scope, branch_scope, home_location_id, membership_locations(location_id), roles(name, permissions), orgs(*)",
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

  return {
    userId: user.id,
    orgId: membership.org_id,
    roleId: membership.role_id,
    roleName: role.name,
    membershipId: membership.id,
    status: membership.status as "active" | "suspended",
    presence: membership.presence as "online" | "away" | "offline",
    enquiryScope: parseEnquiryScope(membership.enquiry_scope),
    branchScope: parseBranchScope(membership.branch_scope),
    branchIds: (membership.membership_locations ?? []).map((l) => l.location_id),
    homeLocationId: membership.home_location_id,
    permissions,
    user,
    profile,
    org,
    orgs: memberships
      .map((m) => m.orgs)
      .filter((o): o is NonNullable<typeof o> => !!o)
      .map((o) => ({ id: o.id, name: o.name, slug: o.slug })),
  };
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

/** requireMember() plus a permission check; throws ForbiddenError when missing. */
export async function requirePerm(permission: string): Promise<CurrentMember> {
  const member = await requireMember();
  assertCan(member, permission);
  return member;
}
