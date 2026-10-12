import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type FakeState = {
  user: { id: string } | null;
  aal: { currentLevel: string | null; nextLevel: string | null } | null;
  memberships: Array<{ org_id: string; roles: { require_mfa: boolean } | null }>;
  queries: number;
};
const state: FakeState = { user: null, aal: null, memberships: [], queries: 0 };

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user } }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: state.aal }) },
    },
    from: () => {
      state.queries += 1;
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: async () => ({ data: state.memberships }),
      };
      return chain;
    },
  }),
}));

import { updateSession } from "@/lib/supabase/middleware";

const req = (path: string, cookie?: string) =>
  new NextRequest(`https://pulse.test${path}`, { headers: cookie ? { cookie } : undefined });
const target = (res: Response) =>
  res.headers.get("location") ? new URL(res.headers.get("location")!).pathname : null;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  state.user = { id: "u1" };
  state.aal = { currentLevel: "aal1", nextLevel: "aal1" };
  state.memberships = [{ org_id: "o1", roles: { require_mfa: false } }];
  state.queries = 0;
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
