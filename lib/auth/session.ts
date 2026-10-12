import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";

import { assertCan, type MemberLike } from "@/lib/auth/can";
import { AUTH_MODE_HEADER, isAuthMode } from "@/lib/supabase/auth-mode";
import { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/types";

export const ORG_COOKIE = "pulse_org";

export type CurrentMember = MemberLike & {
  membershipId: string;
  user: User;
  profile: Tables<"profiles">;
  org: Tables<"orgs">;
  presence: "online" | "away" | "offline";
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
 * first active one). Null when signed out or without a membership.
 * Reads go through the user's own client so RLS applies.
 */
export const getCurrentMember = cache(async (): Promise<CurrentMember | null> => {
  const user = await getCurrentUser();
  if (!user) return null;

  const supabase = await createClient();
  const { data: memberships } = await supabase
    .from("memberships")
    .select("id, org_id, role_id, status, presence, roles(name, permissions), orgs(*)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at");

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
