import { beforeEach, describe, expect, it, vi } from "vitest";

// The finance access window wired into lib/auth/session.ts: decided once per request from the org row, takes away
// finance/accounting permissions only, records refusals on finance paths, redirects pages and errors actions.
// Synthetic ids and documentation-range addresses only.

const ROLE = "11111111-1111-4111-8111-111111111111";

const state: {
  headers: Record<string, string>;
  permissions: string[];
  settings: Record<string, unknown>;
} = { headers: {}, permissions: [], settings: {} };

const noteFinanceDenial = vi.fn(async () => {});
const redirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(state.headers),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));
vi.mock("@/lib/security/finance-access-server", () => ({ noteFinanceDenial }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const memberships = {
      select: () => memberships,
      eq: () => memberships,
      order: async () => ({
        data: [
          {
            id: "m-1",
            org_id: "org-1",
            role_id: ROLE,
            status: "active",
            presence: "online",
            enquiry_scope: "all",
            roles: { name: "Finance", permissions: state.permissions },
            orgs: {
              id: "org-1",
              name: "Org",
              slug: "org",
              timezone: "Asia/Dubai",
              settings: state.settings,
            },
          },
        ],
        error: null,
      }),
    };
    const profiles = {
      select: () => profiles,
      eq: () => profiles,
      single: async () => ({ data: { id: "user-1", first_name: "A", last_name: "B" } }),
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
      from: (t: string) => (t === "profiles" ? profiles : memberships),
    };
  },
}));

// CLOSED: an address list the request (203.0.113.7) is not on; OPEN: one it is on. Hours are not limited.
const CLOSED = {
  finance_access: {
    enabled: true,
    limit_hours: false,
    days: [],
    ip_allowlist: ["198.51.100.0/24"],
  },
};
const OPEN = {
  finance_access: { enabled: true, limit_hours: false, days: [], ip_allowlist: ["203.0.113.0/24"] },
};

async function load() {
  vi.resetModules();
  return import("@/lib/auth/session");
}

describe("finance access window in the session", () => {
  beforeEach(() => {
    noteFinanceDenial.mockClear();
    redirect.mockClear();
    state.headers = { "x-real-ip": "203.0.113.7", "x-pulse-path": "/dashboard" };
    state.permissions = ["finance.view", "accounting.journals.view", "inbox.send"];
    state.settings = {};
  });

  it("changes nothing while the window is off", async () => {
    const { getCurrentMember } = await load();
    const m = (await getCurrentMember())!;
    expect(m.financeAccess).toEqual({ allowed: true, reason: "off" });
    expect(m.restrictedAreas).toEqual([]);
    expect(m.clientIp?.bytes).toEqual([203, 0, 113, 7]);
  });

  it("allows a member inside the window", async () => {
    state.settings = OPEN;
    const { getCurrentMember } = await load();
    const m = (await getCurrentMember())!;
    expect(m.financeAccess.allowed).toBe(true);
    const { can } = await import("@/lib/auth/can");
    expect(can(m, "finance.view")).toBe(true);
  });

  it("takes away finance and accounting only, and does not record a refusal off the finance pages", async () => {
    state.settings = CLOSED;
    const { getCurrentMember } = await load();
    const { can } = await import("@/lib/auth/can");
    const m = (await getCurrentMember())!;
    expect(m.financeAccess).toEqual({ allowed: false, reason: "ip_not_allowed" });
    expect(can(m, "finance.view")).toBe(false);
    expect(can(m, "accounting.journals.view")).toBe(false);
    expect(can(m, "inbox.send")).toBe(true);
    expect(noteFinanceDenial).not.toHaveBeenCalled();
  });

  it("records a refusal when a finance page, action or API route is reached", async () => {
    state.settings = CLOSED;
    for (const path of [
      "/finance/bank",
      "/accounting",
      "/api/finance/summary",
      "/api/accounting/statements",
    ]) {
      noteFinanceDenial.mockClear();
      state.headers["x-pulse-path"] = path;
      const { getCurrentMember, requirePerm } = await load();
      await getCurrentMember();
      // the alert itself is deduped in the database (one per member per day); here it is at least raised
      await requirePerm("finance.view").catch(() => {});
      expect(noteFinanceDenial, path).toHaveBeenCalled();
    }
  });

  it("fails closed without an address when a list is set", async () => {
    state.settings = OPEN;
    state.headers = {};
    const { getCurrentMember } = await load();
    expect((await getCurrentMember())!.financeAccess).toEqual({
      allowed: false,
      reason: "ip_unknown",
    });
  });

  it("never restricts Admin", async () => {
    state.settings = CLOSED;
    state.permissions = ["*"];
    const { getCurrentMember, requirePerm } = await load();
    const m = (await getCurrentMember())!;
    expect(m.financeAccess).toEqual({ allowed: true, reason: "admin" });
    await expect(requirePerm("finance.bank.manage")).resolves.toMatchObject({ userId: m.userId });
  });

  it("fails closed for finance roles on an unreadable stored setting", async () => {
    state.settings = { finance_access: { enabled: "maybe" } };
    const { getCurrentMember } = await load();
    expect((await getCurrentMember())!.financeAccess).toEqual({
      allowed: false,
      reason: "invalid_settings",
    });
  });

  it("sends a refused page navigation to the explanation page", async () => {
    state.settings = CLOSED;
    const { requirePerm, FINANCE_UNAVAILABLE_PATH } = await load();
    await expect(requirePerm("finance.view")).rejects.toThrow(
      `REDIRECT:${FINANCE_UNAVAILABLE_PATH}`,
    );
    expect(noteFinanceDenial).toHaveBeenCalledTimes(1);
  });

  it("answers a refused server action with a ForbiddenError, not a redirect", async () => {
    state.settings = CLOSED;
    state.headers["next-action"] = "abc";
    const { requirePerm } = await load();
    const err = await requirePerm("finance.view").catch((e: unknown) => e);
    expect((err as Error).name).toBe("ForbiddenError");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("keeps the normal ForbiddenError for a permission the role never had", async () => {
    state.settings = CLOSED;
    const { requirePerm } = await load();
    const err = await requirePerm("finance.costs.compensation").catch((e: unknown) => e);
    expect((err as Error).name).toBe("ForbiddenError");
    expect(redirect).not.toHaveBeenCalled();
    // and a non-finance permission is untouched
    await expect(requirePerm("inbox.send")).resolves.toBeTruthy();
  });

  it("the module gate sends a refused member to the explanation page and lets an allowed one through", async () => {
    state.settings = CLOSED;
    let s = await load();
    await expect(s.enforceFinanceWindow((await s.getCurrentMember())!)).rejects.toThrow(
      "REDIRECT:",
    );
    state.settings = OPEN;
    s = await load();
    await expect(s.enforceFinanceWindow((await s.getCurrentMember())!)).resolves.toBeUndefined();
  });
});
