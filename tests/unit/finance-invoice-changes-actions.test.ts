/**
 * Phase 20J server-action and route gating with the session and the database replaced by fakes: reviewing an invoice
 * change (one or in bulk) needs finance.changes.review (viewing the register or every other finance key is not enough),
 * the settings need finance.reference.manage, and the CSV download answers 401 / 403 / 400, all before the service role is
 * created. No network. Synthetic ids only.
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

import * as changes from "@/app/(app)/finance/invoice-changes/actions";
import * as workflow from "@/app/(app)/finance/workflow-settings/actions";
import { GET as changesGet } from "@/app/api/finance/invoice-changes/route";

const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.signedIn = true;
};
const EVERY_OTHER_FINANCE_KEY = [
  "finance.view",
  "finance.invoices.view",
  "finance.claims.view",
  "finance.exceptions.manage",
  "finance.reference.manage",
  "finance.recovery.approve",
  "finance.close.signoff.ceo",
  "finance.revenue.view",
  "finance.flash.view",
  "finance.followup.manage",
  "finance.changes.view",
  "settings.manage",
];
const review = {
  change_key: "0123456789abcdef0123456789abcdef",
  change_date: "2026-10-05",
  decision: "approved",
  reason: "Approved by the operations manager (ref SYN-1)",
};
const bulk = { from: "2026-10-01", to: "2026-10-31", kind: "", reason: "Routine small discounts" };

beforeEach(() => as());

describe("Phase 20J invoice-change review actions", () => {
  it("refuse a member without finance.changes.review before reaching the data", async () => {
    for (const perms of [[], ["finance.changes.view"], EVERY_OTHER_FINANCE_KEY]) {
      as(...perms);
      for (const res of [
        await changes.reviewChange(review),
        await changes.bulkApproveChanges(bulk),
      ]) {
        expect(res).toMatchObject({ ok: false });
        expect((res as { error: string }).error).toMatch(/permission/);
      }
      expect(state.adminCalls).toBe(0);
    }
  });

  it("validate before touching data: key, date, decision and reason; period, kind and reason for bulk", async () => {
    as("finance.changes.review");
    for (const bad of [
      { ...review, change_key: "../etc" },
      { ...review, change_key: "0123456789ABCDEF0123456789ABCDEF" },
      { ...review, change_date: "2026-02-30" },
      { ...review, decision: "waved_through" },
      { ...review, reason: "   " },
      { ...review, reason: "x".repeat(501) },
    ])
      expect(await changes.reviewChange(bad), JSON.stringify(bad).slice(0, 80)).toMatchObject({
        ok: false,
      });
    for (const bad of [
      { ...bulk, to: "2026-09-30" },
      { ...bulk, from: "2025-01-01" },
      { ...bulk, kind: "price_override" },
      { ...bulk, reason: "" },
    ])
      expect(await changes.bulkApproveChanges(bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
      });
    expect(state.adminCalls).toBe(0);
  });

  it("with the permission and a valid form it goes on to the database", async () => {
    as("finance.changes.review");
    await expect(changes.reviewChange(review)).rejects.toThrow(/must not be reached/);
    expect(state.adminCalls).toBe(1);
    as("finance.changes.review");
    await expect(changes.bulkApproveChanges(bulk)).rejects.toThrow(/must not be reached/);
    expect(state.adminCalls).toBe(1);
  });
});

describe("Phase 20J settings (requirePerm finance.reference.manage)", () => {
  const form = {
    change_review_start_date: "",
    change_review_min_amount: "0",
    change_bulk_approve_max: "0",
  };

  it("refuses without the reference permission, even with review rights", async () => {
    as("finance.changes.review", "finance.changes.view");
    await expect(workflow.saveChangeReviewSettings(form)).rejects.toBeInstanceOf(ForbiddenError);
    expect(state.adminCalls).toBe(0);
  });

  it("refuses negative or absurd amounts and bad dates", async () => {
    as("finance.reference.manage");
    for (const bad of [
      { ...form, change_review_min_amount: "-1" },
      { ...form, change_bulk_approve_max: "10000000" },
      { ...form, change_bulk_approve_max: "lots" },
      { ...form, change_review_start_date: "2026-13-01" },
    ])
      expect(await workflow.saveChangeReviewSettings(bad)).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });
});

describe("Phase 20J CSV download", () => {
  const req = (path: string) => new Request(`https://pulse.test${path}`);

  it("answers 401 signed out, 403 without finance.changes.view, 400 for a bad period", async () => {
    state.signedIn = false;
    expect((await changesGet(req("/api/finance/invoice-changes"))).status).toBe(401);
    as("finance.changes.review", "finance.invoices.view", "finance.view");
    expect((await changesGet(req("/api/finance/invoice-changes"))).status).toBe(403);
    as("finance.changes.view");
    expect(
      (await changesGet(req("/api/finance/invoice-changes?from=2026-10-31&to=2026-10-01"))).status,
    ).toBe(400);
    expect(state.adminCalls).toBe(0);
  });
});
