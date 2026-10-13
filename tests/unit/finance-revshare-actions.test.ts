/**
 * Slice 20F server-action and route gating with the session and the database replaced by fakes: every revenue-share
 * action needs the key for what it does (manage to prepare, verify to verify or return to draft, approve to approve or
 * retire), a neighbour's key is not enough, and nothing reaches the service role before the check. The trail CSV
 * answers 401 / 403. No network. Synthetic ids only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

import * as rs from "@/app/(app)/finance/revenue-share/actions";
import { GET as trailGet } from "@/app/api/finance/revenue-share/route";

const ID = "00000000-0000-4000-8000-0000000000aa";
const HASH = "a".repeat(64);
const as = (...permissions: string[]) => {
  state.permissions = permissions;
  state.adminCalls = 0;
  state.signedIn = true;
};
const OTHER_FINANCE = [
  "finance.view",
  "finance.invoices.view",
  "finance.revenue.view",
  "finance.costs.manage",
  "finance.costs.view",
  "finance.costs.compensation",
  "finance.profit.view",
  "finance.profit.approve",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
  "finance.flash.view",
  "finance.targets.manage",
  "settings.manage",
];
const REVSHARE = [
  "finance.revshare.view",
  "finance.revshare.manage",
  "finance.revshare.verify",
  "finance.revshare.approve",
];
const without = (k: string) => [...OTHER_FINANCE, ...REVSHARE.filter((p) => p !== k)];

type Call = { name: string; key: string; run: () => Promise<unknown> };
const calls: Call[] = [
  {
    name: "build",
    key: "finance.revshare.manage",
    run: () => rs.buildRevshareRun({ month: "2026-09" }),
  },
  {
    name: "verify",
    key: "finance.revshare.verify",
    run: () => rs.verifyRevshareRun({ id: ID, month: "2026-09", hash: HASH }),
  },
  {
    name: "withdraw",
    key: "finance.revshare.verify",
    run: () => rs.withdrawRevshareRun({ id: ID, month: "2026-09", hash: HASH }),
  },
  {
    name: "approve",
    key: "finance.revshare.approve",
    run: () => rs.approveRevshareRun({ id: ID, month: "2026-09", hash: HASH }),
  },
  {
    name: "post",
    key: "finance.revshare.manage",
    run: () => rs.postRevshareRun({ id: ID, month: "2026-09", ref: "JV-1" }),
  },
  {
    name: "pay",
    key: "finance.revshare.manage",
    run: () =>
      rs.recordRevsharePayment({
        line_id: ID,
        month: "2026-09",
        paid_on: "2026-10-01",
        ref: "TRF-1",
      }),
  },
  {
    name: "save scheme",
    key: "finance.revshare.manage",
    run: () =>
      rs.saveRevshareScheme({
        scheme_id: "",
        doctor_dha_id: "SYN-0001",
        effective_month: "2026-09",
        default_pct: "30",
      }),
  },
  {
    name: "scheme verify",
    key: "finance.revshare.verify",
    run: () => rs.revshareSchemeStep({ id: ID, step: "verify", hash: HASH }),
  },
  {
    name: "scheme approve",
    key: "finance.revshare.approve",
    run: () => rs.revshareSchemeStep({ id: ID, step: "approve", hash: HASH }),
  },
  {
    name: "scheme retire",
    key: "finance.revshare.approve",
    run: () => rs.revshareSchemeStep({ id: ID, step: "retire", hash: HASH }),
  },
  {
    name: "scheme delete",
    key: "finance.revshare.manage",
    run: () => rs.revshareSchemeStep({ id: ID, step: "delete", hash: HASH }),
  },
  {
    name: "add charge",
    key: "finance.revshare.manage",
    run: () =>
      rs.addDoctorCharge({
        month: "2026-09",
        doctor_dha_id: "SYN-0001",
        kind: "lab",
        amount: "10",
      }),
  },
  {
    name: "delete charge",
    key: "finance.revshare.manage",
    run: () => rs.deleteDoctorCharge({ id: ID }),
  },
  {
    name: "upload charges",
    key: "finance.revshare.manage",
    run: () => rs.uploadDoctorCharges("month,doctor_dha_id,kind,amount\n2026-09,SYN-0001,lab,10\n"),
  },
];

beforeEach(() => as());

describe("revenue share actions (20F)", () => {
  it("each action refuses without its own key (every other key is not enough) before reaching the data", async () => {
    for (const c of calls)
      for (const perms of [[], without(c.key)]) {
        as(...perms);
        const res = (await c.run()) as { ok: boolean; error?: string };
        expect(res.ok, `${c.name} with ${perms.length} keys`).toBe(false);
        expect(res.error, c.name).toMatch(/permission/);
        expect(state.adminCalls, c.name).toBe(0);
      }
  });

  it("validates before touching data", async () => {
    as(...REVSHARE);
    for (const run of [
      () => rs.buildRevshareRun({ month: "2026-13" }),
      () => rs.buildRevshareRun({ month: "2999-01" }),
      () => rs.verifyRevshareRun({ id: "../x", month: "2026-09", hash: HASH }),
      () => rs.approveRevshareRun({ id: ID, month: "2026-09", hash: "short" }),
      () => rs.postRevshareRun({ id: ID, month: "2026-09", ref: "" }),
      () =>
        rs.recordRevsharePayment({
          line_id: ID,
          month: "2026-09",
          paid_on: "2026-02-30",
          ref: "X",
        }),
      () =>
        rs.recordRevsharePayment({
          line_id: ID,
          month: "2026-09",
          paid_on: "2999-01-01",
          ref: "X",
        }),
      () => rs.revshareSchemeStep({ id: ID, step: "publish", hash: HASH }),
      () =>
        rs.saveRevshareScheme({ doctor_dha_id: "", effective_month: "2026-09", default_pct: "30" }),
      () =>
        rs.addDoctorCharge({
          month: "2026-09",
          doctor_dha_id: "SYN-0001",
          kind: "rent",
          amount: "10",
        }),
      () =>
        rs.addDoctorCharge({
          month: "2026-09",
          doctor_dha_id: "SYN-0001",
          kind: "lab",
          amount: "0",
        }),
      () =>
        rs.addDoctorCharge({
          month: "2026-09",
          doctor_dha_id: "SYN-0001",
          kind: "lab",
          amount: "1.005",
        }),
      () => rs.uploadDoctorCharges(""),
      () => rs.uploadDoctorCharges("month,doctor_dha_id,kind,amount,patient_name\n"),
    ])
      expect(await run()).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });

  it("the trail CSV answers 401 signed out and 403 without a revenue-share key", async () => {
    state.signedIn = false;
    expect(
      (await trailGet(new Request("http://x.test/api/finance/revenue-share?month=2026-09"))).status,
    ).toBe(401);
    as(...OTHER_FINANCE);
    expect(
      (await trailGet(new Request("http://x.test/api/finance/revenue-share?month=2026-09"))).status,
    ).toBe(403);
    as("finance.revshare.view");
    expect(
      (await trailGet(new Request("http://x.test/api/finance/revenue-share?month=bad"))).status,
    ).toBe(400);
    expect(state.adminCalls).toBe(0);
  });
});
