import { beforeEach, describe, expect, it, vi } from "vitest";

// A failed membership lookup must never look like "no workspace" (it sent members to /onboarding to create a
// duplicate when production lacked a migration the query needs).

const state: { result: { data: unknown; error: { code: string; message: string } | null } } = {
  result: { data: [], error: null },
};

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const query = {
      select: () => query,
      eq: () => query,
      order: async () => state.result,
    };
    return {
      auth: {
        getUser: async () => ({ data: { user: { id: "user-1", email: "staff@example.test" } } }),
      },
      from: () => query,
    };
  },
}));

const { getCurrentMember, getCurrentMemberIfAvailable, isMemberLookupError, MemberLookupError } =
  await import("@/lib/auth/session");

describe("getCurrentMember", () => {
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));

  it("returns null when the person has no workspace", async () => {
    state.result = { data: [], error: null };
    await expect(getCurrentMember()).resolves.toBeNull();
  });

  it("throws MemberLookupError when the lookup fails, and logs no address", async () => {
    state.result = {
      data: null,
      error: {
        code: "42703",
        message: "column memberships.enquiry_scope does not exist (staff@example.test)",
      },
    };
    const err = await getCurrentMember().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemberLookupError);
    expect(isMemberLookupError(err)).toBe(true);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("staff@example.test");
  });

  it("lets sign-out and auth logging carry on when the lookup fails", async () => {
    state.result = { data: null, error: { code: "42703", message: "column does not exist" } };
    await expect(getCurrentMemberIfAvailable()).resolves.toBeNull();
  });

  it("tells a lookup failure apart from other errors", () => {
    expect(isMemberLookupError(new Error("boom"))).toBe(false);
    expect(isMemberLookupError(null)).toBe(false);
  });
});
