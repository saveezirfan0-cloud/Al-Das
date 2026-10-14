/**
 * Phase 20I server-action and route gating with the session and the database replaced by fakes: recording a follow-up
 * needs finance.followup.manage (claim access or every other finance key is not enough), the settings need
 * finance.reference.manage, and the receivables download answers 401 / 403, all before the service role is created.
 * No network. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ForbiddenError } from "@/lib/auth/can";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  signedIn: true,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", async () => {
  const can = (await import("@/lib/auth/can")) as { assertCan: (m: unknown, p: string) => void };
  const member = () => ({
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
  });
  return {
    requirePerm: async (p: string) => {
      const m = member();
      can.assertCan(m, p);
      return m;
    },
    requireMember: async () => member(),
    getCurrentMember: async () => (state.signedIn ? member() : null),
  };
});
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    throw new Error("the service role must not be reached by an unauthorised call");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    state.adminCalls++;
    throw new Error("the data layer must not be reached by an unauthorised call");
  },
}));
vi.mock("@/lib/audit", () => ({ recordAudit: async () => {} }));
vi.mock("@/lib/security/access-log", () => ({
  recordAccess: async () => {},
  recordExport: async () => {},
}));

import * as followup from "@/app/(app)/finance/followup/actions";
import * as workflow from "@/app/(app)/finance/workflow-settings/actions";
import { GET as receivablesGet } from "@/app/api/finance/receivables/route";

const CLAIM = "00000000-0000-4000-8000-0000000000aa";
const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.signedIn = true;
};
const EVERY_OTHER_FINANCE_KEY = [
  "finance.view",
  "finance.invoices.view",
  "finance.claims.view",
  "finance.claims.import",
  "finance.exceptions.manage",
  "finance.reference.manage",
  "finance.preauth.manage",
  "finance.eligibility.manage",
  "finance.denials.manage",
  "finance.remittance.manage",
  "finance.scorecards.view",
  "finance.forecast.view",
  "finance.close.view",
  "finance.revenue.view",
  "finance.flash.view",
  "finance.targets.manage",
  "tasks.manage",
  "settings.manage",
];
const valid = { claim_id: CLAIM, outcome: "contacted", note: "", next_action_date: "" };

beforeEach(() => as());

describe("Phase 20I follow-up actions", () => {
  it("refuses a member without finance.followup.manage before reaching the data", async () => {
    for (const perms of [[], ["finance.claims.view"], EVERY_OTHER_FINANCE_KEY]) {
      as(...perms);
      const res = await followup.addFollowup(valid);
      expect(res).toMatchObject({ ok: false });
      expect((res as { error: string }).error).toMatch(/permission/);
      expect(state.adminCalls).toBe(0);
    }
  });

  it("validates before touching data: id, outcome, note length and a past next-action date", async () => {
    as("finance.followup.manage");
    for (const bad of [
      { ...valid, claim_id: "../etc" },
      { ...valid, outcome: "paid" },
      { ...valid, note: "x".repeat(1001) },
      { ...valid, next_action_date: "2026-02-30" },
      { ...valid, next_action_date: "2000-01-01" },
    ]) {
      expect(await followup.addFollowup(bad), JSON.stringify(bad).slice(0, 60)).toMatchObject({
        ok: false,
      });
    }
    expect(state.adminCalls).toBe(0);
  });

  it("with the permission and a valid form it goes on to the database", async () => {
    as("finance.followup.manage");
    await expect(followup.addFollowup(valid)).rejects.toThrow(/must not be reached/);
    expect(state.adminCalls).toBe(1);
  });
});

describe("Phase 20I settings (requirePerm finance.reference.manage)", () => {
  const form = {
    ageing_bucket_days: "30, 60, 90, 120",
    followup_stage_days: "60, 90, 120",
    followup_start_date: "",
    followup_task_role: "Insurance",
    followup_task_due_days: "3",
  };

  it("refuses without the reference permission, even with follow-up rights", async () => {
    as("finance.followup.manage", "finance.claims.view");
    await expect(workflow.saveFollowupSettings(form)).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.adminCalls).toBe(0);
  });

  it("refuses bucket and stage lists that are not increasing whole days", async () => {
    as("finance.reference.manage");
    for (const bad of [
      { ...form, ageing_bucket_days: "60, 30" },
      { ...form, ageing_bucket_days: "" },
      { ...form, ageing_bucket_days: "1,2,3,4,5,6,7,8,9" },
      { ...form, followup_stage_days: "60, 60" },
      { ...form, followup_stage_days: "sixty" },
      { ...form, followup_task_role: " " },
      { ...form, followup_task_due_days: "99" },
    ])
      expect(await workflow.saveFollowupSettings(bad)).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });
});

describe("Phase 20I receivables download", () => {
  const req = (path: string) => new Request(`https://pulse.test${path}`);

  it("answers 401 when signed out and 403 without claim access", async () => {
    state.signedIn = false;
    expect((await receivablesGet(req("/api/finance/receivables"))).status).toBe(401);
    as("finance.view", "finance.revenue.view", "finance.followup.manage");
    expect((await receivablesGet(req("/api/finance/receivables"))).status).toBe(403);
    expect(state.adminCalls).toBe(0);
  });
});
