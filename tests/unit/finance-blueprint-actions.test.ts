/**
 * Server-action gating for the cost inputs, with the session and the database replaced by fakes: each action refuses a
 * member who lacks ITS OWN permission before the service role is created, a valid file is saved through one atomic
 * function call, and an invalid file saves nothing. No network. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  adminCalls: 0,
  rpcError: null as null | { code: string; message: string },
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireMember: async () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    roleId: "r",
    roleName: "Test",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
    profile: { first_name: "T", last_name: "U" },
    user: { email: "t@example.test" },
    orgs: [],
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        return { data: null, error: state.rpcError };
      },
    };
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));

import { setCostMonth, uploadCosts } from "@/app/(app)/finance/costs/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.rpcCalls = [];
  state.audits = [];
  state.adminCalls = 0;
  state.rpcError = null;
};
const SERVICES = "item_code,effective_from,unit_cost\nT-1,2026-01-01,10\n";
const COMP = "month,doctor_dha_id,amount\n2026-09,D1,1000\n";
const OVERHEADS = "month,pool,amount\n2026-09,Rent,500\n";

describe("cost uploads", () => {
  beforeEach(() => as());

  it("refuses a member without the right permission before the service role exists", async () => {
    // costs.manage does not cover doctor compensation, and compensation does not cover services
    as(
      "finance.costs.manage",
      "finance.costs.view",
      "finance.profit.view",
      "finance.profit.approve",
    );
    expect((await uploadCosts("compensation", COMP)).ok).toBe(false);
    as("finance.costs.compensation", "finance.costs.view", "finance.view");
    expect((await uploadCosts("services", SERVICES)).ok).toBe(false);
    expect((await uploadCosts("overheads", OVERHEADS)).ok).toBe(false);
    as();
    for (const k of ["services", "compensation", "overheads"])
      expect((await uploadCosts(k, "x")).ok, k).toBe(false);
    expect(state.adminCalls).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it("saves a valid file through one atomic call and audits it without the amounts", async () => {
    as("finance.costs.manage");
    const r = await uploadCosts("services", SERVICES);
    expect(r).toMatchObject({ ok: true, data: { rows: 1 } });
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("fin_cost_upsert");
    expect(state.rpcCalls[0].args).toMatchObject({ p_kind: "services" });
    expect(state.audits[0]).toMatchObject({
      action: "finance.costs.services_uploaded",
      diff: { rows: 1 },
    });
    expect(JSON.stringify(state.audits)).not.toContain("10");
  });

  it("each kind needs its own key", async () => {
    as("finance.costs.compensation");
    expect((await uploadCosts("compensation", COMP)).ok).toBe(true);
    as("finance.costs.manage");
    expect((await uploadCosts("overheads", OVERHEADS)).ok).toBe(true);
  });

  it("an invalid file saves nothing and names the problem", async () => {
    as("finance.costs.manage");
    const r = await uploadCosts(
      "services",
      "item_code,effective_from,unit_cost\nT-1,2026-01-01,0\n",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Nothing was saved.*above 0/);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("rejects an unknown kind, an empty file and an oversized file", async () => {
    as("finance.costs.manage", "finance.costs.compensation");
    expect((await uploadCosts("nonsense", SERVICES)).ok).toBe(false);
    expect((await uploadCosts("services", "   ")).ok).toBe(false);
    expect((await uploadCosts("services", "x".repeat(1_500_001))).ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(0);
  });

  it("an approved month is reported as a friendly message, not a database error", async () => {
    as("finance.costs.compensation");
    state.rpcError = { code: "42501", message: "the month 2026-09-01 is approved" };
    const r = await uploadCosts("compensation", COMP);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/not allowed|Nothing was saved/);
      expect(r.error).not.toContain("2026-09-01 is approved"); // raw database text is not shown
    }
    expect(state.audits).toHaveLength(0);
  });
});

describe("month approval", () => {
  beforeEach(() => as());
  it("needs finance.profit.approve", async () => {
    as("finance.costs.manage", "finance.profit.view", "finance.costs.compensation");
    expect((await setCostMonth("2026-09", "approved")).ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });
  it("approves and reopens with an audit entry, and refuses bad input", async () => {
    as("finance.profit.approve");
    expect((await setCostMonth("2026-09", "approved")).ok).toBe(true);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "fin_cost_set_period",
      args: { p_month: "2026-09-01", p_status: "approved" },
    });
    expect(state.audits[0]).toMatchObject({
      action: "finance.costs.month_approved",
      diff: { month: "2026-09-01" },
    });
    expect((await setCostMonth("2026-09", "draft")).ok).toBe(true);
    expect(state.audits[1]).toMatchObject({ action: "finance.costs.month_reopened" });
    expect((await setCostMonth("2026-13", "approved")).ok).toBe(false);
    expect((await setCostMonth("2026-09", "deleted")).ok).toBe(false);
    expect(state.rpcCalls).toHaveLength(2);
  });
});
