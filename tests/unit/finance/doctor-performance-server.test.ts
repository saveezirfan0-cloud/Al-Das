import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 23B loader: branch scoping (Phase B). A member limited to one branch gets only that branch's finance code (and
 * so the SQL keeps rows of that branch plus rows with no branch); the switcher narrows further; nobody is widened.
 */

let cookie: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (cookie ? { value: cookie } : undefined) }),
}));

import { loadDoctorPerformance, loadPerfScope } from "@/lib/finance/doctor-performance-server";
import type { AdminClient } from "@/lib/supabase/admin";

const LOCATIONS = [
  { id: "00000000-0000-4000-8000-000000000001", branch_code: "PJ", active: true },
  { id: "00000000-0000-4000-8000-000000000002", branch_code: "GM", active: true },
  { id: "00000000-0000-4000-8000-000000000003", branch_code: null, active: true },
];
const BRANCHES = [
  { code: "GM", name: "Golden Mile" },
  { code: "MD", name: "Meadows" },
  { code: "PJ", name: "Palm Jumeirah" },
];

function fakeAdmin() {
  const rpc = vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>
  >(async () => ({ data: {}, error: null }));
  const from = (table: string) => {
    const data = table === "locations" ? LOCATIONS : BRANCHES;
    const q = { select: () => q, eq: () => q, order: async () => ({ data, error: null }) };
    return q;
  };
  return { admin: { from, rpc } as unknown as AdminClient, rpc };
}

const member = (over: Record<string, unknown> = {}) => ({
  orgId: "org",
  branchScope: "all" as const,
  branchIds: [] as string[],
  homeLocationId: null,
  ...over,
});

beforeEach(() => {
  cookie = undefined;
});

describe("loadPerfScope", () => {
  it("leaves an unrestricted member unrestricted, with every finance branch to choose from", async () => {
    const { admin } = fakeAdmin();
    const s = await loadPerfScope(admin, member());
    expect(s.allowed).toBeNull();
    expect(s.branches.map((b) => b.code)).toEqual(["GM", "MD", "PJ"]);
  });

  it("keeps a member limited to one branch to that branch's code", async () => {
    const { admin, rpc } = fakeAdmin();
    const m = member({ branchScope: "selected", branchIds: [LOCATIONS[1].id] });
    const s = await loadPerfScope(admin, m);
    expect(s).toEqual({ allowed: ["GM"], branches: [{ code: "GM", name: "Golden Mile" }] });
    await loadDoctorPerformance(admin, "org", {
      month: "2026-09-01",
      branch: null,
      allowed: s.allowed,
    });
    expect(rpc).toHaveBeenCalledWith("fin_doctor_performance_inputs", {
      p_org_id: "org",
      p_month: "2026-09-01",
      p_branch: undefined,
      p_branches: ["GM"],
    });
  });

  it("follows the branch switcher, which narrows but never widens", async () => {
    const { admin } = fakeAdmin();
    cookie = LOCATIONS[0].id;
    expect((await loadPerfScope(admin, member())).allowed).toEqual(["PJ"]);
    // a limited member's cookie pointing at another branch is ignored
    const limited = member({ branchScope: "selected", branchIds: [LOCATIONS[1].id] });
    expect((await loadPerfScope(admin, limited)).allowed).toEqual(["GM"]);
  });

  it("gives a member whose branches have no finance code only rows with no branch", async () => {
    const { admin, rpc } = fakeAdmin();
    const s = await loadPerfScope(
      admin,
      member({ branchScope: "selected", branchIds: [LOCATIONS[2].id] }),
    );
    expect(s).toEqual({ allowed: [], branches: [] });
    await loadDoctorPerformance(admin, "org", {
      month: "2026-09-01",
      branch: null,
      allowed: s.allowed,
    });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_branches: [] });
  });
});
