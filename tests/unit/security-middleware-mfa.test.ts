import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeState = {
  user: { id: string } | null;
  aal: { currentLevel: string | null; nextLevel: string | null } | null;
  memberships: Array<{ org_id: string; roles: { require_mfa: boolean } | null }>;
  membershipError: { message: string } | null;
  queries: number;
  /** Which verification calls the middleware made, in order. */
  authCalls: string[];
};
const state: FakeState = {
  user: null,
  aal: null,
  memberships: [],
  membershipError: null,
  queries: 0,
  authCalls: [],
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => {
        state.authCalls.push("getUser");
        return { data: { user: state.user } };
      },
      getClaims: async () => {
        state.authCalls.push("getClaims");
        return { data: state.user ? { claims: { sub: state.user.id } } : null, error: null };
      },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: state.aal }) },
    },
    from: () => {
      state.queries += 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: async () => ({
          data: state.membershipError ? null : state.memberships,
          error: state.membershipError,
        }),
      };
      return chain;
    },
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";

const req = (
  path: string,
  cookie?: string,
  init: { method?: string; headers?: Record<string, string> } = {},
) =>
  new NextRequest(`https://pulse.test${path}`, {
    method: init.method,
    headers: { ...(cookie ? { cookie } : {}), ...init.headers },
  });
const target = (res: Response) =>
  res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  state.user = { id: "u1" };
  state.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  state.memberships = [{ org_id: "o1", roles: { require_mfa: false } }];
  state.membershipError = null;
  state.queries = 0;
  state.authCalls = [];
});

describe("middleware two-step verification", () => {
  it("lets an ordinary member through without extra work beyond one lookup", async () => {
    const res = await updateSession(req("/inbox"));
    expect(target(res)).toBeNull();
    expect(state.queries).toBe(1);
  });

  it("sends a member of a required role without an authenticator to enrol, remembering where they were going", async () => {
    state.memberships = [{ org_id: "o1", roles: { require_mfa: true } }];
    const res = await updateSession(req("/finance/claims"));
    expect(target(res)).toBe("/mfa/enroll");
    expect(new URL(res.headers.get("location")!).searchParams.get("next")).toBe("/finance/claims");
  });

  it("asks an enrolled user for a code at aal1, with no database lookup", async () => {
    state.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    const res = await updateSession(req("/settings/users"));
    expect(target(res)).toBe("/mfa/verify");
    expect(state.queries).toBe(0);
  });

  it("does nothing more for a verified (aal2) session: no lookup at all", async () => {
    state.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    state.memberships = [{ org_id: "o1", roles: { require_mfa: true } }];
    const res = await updateSession(req("/finance/claims"));
    expect(target(res)).toBeNull();
    expect(state.queries).toBe(0);
  });

  it("uses the role in the org the user has selected", async () => {
    state.memberships = [
      { org_id: "o1", roles: { require_mfa: false } },
      { org_id: "o2", roles: { require_mfa: true } },
    ];
    expect(target(await updateSession(req("/inbox")))).toBeNull();
    expect(target(await updateSession(req("/inbox", "pulse_org=o2")))).toBe("/mfa/enroll");
  });

  it("fails closed when the role cannot be read, instead of assuming MFA is not needed", async () => {
    state.membershipError = { message: "db down" };
    const res = await updateSession(req("/finance/claims"));
    expect(res.status).toBe(503);
    // a verified session never needs the lookup, so it is unaffected
    state.aal = { currentLevel: "aal2", nextLevel: "aal2" };
    expect((await updateSession(req("/finance/claims"))).status).toBe(200);
  });

  it("keeps the MFA pages, sign-out and the public routes reachable", async () => {
    state.memberships = [{ org_id: "o1", roles: { require_mfa: true } }];
    for (const path of ["/mfa/enroll", "/mfa/verify", "/auth/signout"])
      expect(target(await updateSession(req(path))), path).toBeNull();
    expect(state.queries).toBe(0);
    for (const path of ["/api/webhooks/meta", "/api/jobs/outbound", "/api/public/v1/contacts"]) {
      expect(target(await updateSession(req(path))), path).toBeNull();
    }
    expect(state.queries).toBe(0);
  });

  it("still gates the API routes the browser calls (exports) and server actions on app pages", async () => {
    state.memberships = [{ org_id: "o1", roles: { require_mfa: true } }];
    expect(target(await updateSession(req("/api/contacts/export")))).toBe("/mfa/enroll");
    expect(target(await updateSession(req("/api/settings/activity/export")))).toBe("/mfa/enroll");
  });

  it("sends signed-out visitors to the login page, as before", async () => {
    state.user = null;
    expect(target(await updateSession(req("/inbox")))).toBe("/login");
    expect(target(await updateSession(req("/mfa/enroll")))).toBe("/login");
    expect(target(await updateSession(req("/login")))).toBeNull();
  });
});

describe("middleware token verification (Phase 13)", () => {
  it("verifies page navigations locally (getClaims) and never calls Auth for them", async () => {
    await updateSession(req("/inbox"));
    expect(state.authCalls).toEqual(["getClaims"]);
  });

  it("keeps getUser for server actions, other mutating methods and API routes", async () => {
    await updateSession(
      req("/inbox", undefined, { method: "POST", headers: { "next-action": "abc123" } }),
    );
    await updateSession(req("/settings/users", undefined, { method: "POST" }));
    await updateSession(req("/settings/users", undefined, { method: "DELETE" }));
    await updateSession(req("/api/contacts/export"));
    expect(state.authCalls).toEqual(["getUser", "getUser", "getUser", "getUser"]);
  });

  it("applies the two-step verification gate exactly the same on both paths", async () => {
    state.memberships = [{ org_id: "o1", roles: { require_mfa: true } }];
    expect(target(await updateSession(req("/finance/claims")))).toBe("/mfa/enroll");
    expect(
      target(
        await updateSession(
          req("/finance/claims", undefined, { method: "POST", headers: { "next-action": "x" } }),
        ),
      ),
    ).toBe("/mfa/enroll");
    state.aal = { currentLevel: "aal1", nextLevel: "aal2" };
    expect(target(await updateSession(req("/settings/users")))).toBe("/mfa/verify");
  });

  it("redirects a visitor with no valid token to login on the claims path too", async () => {
    state.user = null;
    expect(target(await updateSession(req("/inbox")))).toBe("/login");
    expect(state.authCalls).toEqual(["getClaims"]);
  });

  it("tells the page which mode was used, and overwrites a header the browser tried to set", async () => {
    const page = await updateSession(
      req("/inbox", undefined, { headers: { "x-pulse-auth": "strict" } }),
    );
    expect(page.headers.get("x-middleware-request-x-pulse-auth")).toBe("claims");
    const action = await updateSession(
      req("/inbox", undefined, {
        method: "POST",
        headers: { "next-action": "x", "x-pulse-auth": "claims" },
      }),
    );
    expect(action.headers.get("x-middleware-request-x-pulse-auth")).toBe("strict");
  });

  it("can be switched back to always-strict with PULSE_VERIFY_JWT_LOCALLY=0", async () => {
    process.env.PULSE_VERIFY_JWT_LOCALLY = "0";
    try {
      await updateSession(req("/inbox"));
      expect(state.authCalls).toEqual(["getUser"]);
    } finally {
      delete process.env.PULSE_VERIFY_JWT_LOCALLY;
    }
  });
});
