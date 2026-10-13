/**
 * Server-action gating for the flash report settings, with the session and the database replaced by fakes: every action
 * refuses a member without finance.targets.manage before the service role is created, bad input saves nothing, and
 * valid input goes through one call and is audited. No network. Synthetic data only.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
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
    const chain = {
      delete: () => chain,
      eq: () => chain,
      then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
    };
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        state.rpcCalls.push({ fn, args });
        return { data: 3, error: null };
      },
      from: (table: string) => ({
        upsert: async (row: Record<string, unknown>) => {
          state.upserts.push({ table, row });
          return { error: null };
        },
        delete: () => chain,
      }),
    };
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));

import {
  copyPreviousTargets,
  deleteReportLine,
  saveFlashDisplay,
  saveReportLine,
  saveTargets,
} from "@/app/(app)/finance/flash/settings/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.rpcCalls = [];
  state.upserts = [];
  state.audits = [];
};
const LINE = { code: "palm", label: "Palm", match_kind: "branch", match_values: "P, p ,M", in_core: "on", active: "on", sort_order: "10" };

describe("flash settings actions", () => {
  beforeEach(() => as());

  it("refuse anyone without finance.targets.manage before the service role exists", async () => {
    for (const perms of [[], ["finance.flash.view", "finance.view", "finance.reference.manage"]]) {
      as(...perms);
      expect((await saveReportLine(LINE)).ok).toBe(false);
      expect((await deleteReportLine({ code: "PALM" })).ok).toBe(false);
      expect((await saveTargets({ month: "2026-10", rev_PALM: "1000" })).ok).toBe(false);
      expect((await copyPreviousTargets({ month: "2026-10" })).ok).toBe(false);
      expect((await saveFlashDisplay({ flash_share_basis: "all", flash_top_doctors: "5" })).ok).toBe(false);
      expect(state.adminCalls).toBe(0);
    }
  });

  it("saves a line with a normalised code and de-duplicated values, and audits it", async () => {
    as("finance.targets.manage");
    const r = await saveReportLine(LINE);
    expect(r.ok).toBe(true);
    expect(state.upserts[0].table).toBe("fin_ref_report_lines");
    expect(state.upserts[0].row).toMatchObject({ code: "PALM", match_values: ["P", "p", "M"], in_core: true, active: true, sort_order: 10 });
    expect(state.audits[0]).toMatchObject({ action: "finance.flash.line_saved" });
  });

  it("refuses reserved or malformed line codes and an empty value list", async () => {
    as("finance.targets.manage");
    expect((await saveReportLine({ ...LINE, code: "CORE" })).ok).toBe(false);
    expect((await saveReportLine({ ...LINE, code: "UNASSIGNED" })).ok).toBe(false);
    expect((await saveReportLine({ ...LINE, code: "bad code!" })).ok).toBe(false);
    expect((await saveReportLine({ ...LINE, match_values: " , " })).ok).toBe(false);
    expect((await saveReportLine({ ...LINE, match_kind: "doctor" })).ok).toBe(false);
    expect(state.upserts).toEqual([]);
  });

  it("saves a month of targets through one atomic call, skipping blanks", async () => {
    as("finance.targets.manage");
    const r = await saveTargets({
      month: "2026-10-15",
      rev_PALM: "32,593",
      pat_PALM: "",
      rev_GM: "",
      total_rev: "",
      total_pat: "78.25",
      total_arpp: "750",
      unrelated: "x",
    });
    expect(r.ok).toBe(true);
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].fn).toBe("fin_flash_set_targets");
    expect(state.rpcCalls[0].args.p_month).toBe("2026-10-01");
    expect(state.rpcCalls[0].args.p_rows).toEqual([
      { line_code: "PALM", daily_revenue: 32593, daily_patients: null, arpp: null },
      { line_code: null, daily_revenue: null, daily_patients: 78.25, arpp: 750 },
    ]);
    expect(state.audits[0]).toMatchObject({ action: "finance.flash.targets_saved" });
  });

  it("saves nothing when any amount is invalid or the month is missing", async () => {
    as("finance.targets.manage");
    expect((await saveTargets({ month: "2026-10", rev_PALM: "abc" })).ok).toBe(false);
    expect((await saveTargets({ month: "2026-10", rev_PALM: "-5" })).ok).toBe(false);
    expect((await saveTargets({ month: "", rev_PALM: "5" })).ok).toBe(false);
    expect(state.rpcCalls).toEqual([]);
  });

  it("validates the display settings", async () => {
    as("finance.targets.manage");
    expect((await saveFlashDisplay({ flash_share_basis: "everything", flash_top_doctors: "5" })).ok).toBe(false);
    expect((await saveFlashDisplay({ flash_share_basis: "all", flash_top_doctors: "0" })).ok).toBe(false);
    expect((await saveFlashDisplay({ flash_share_basis: "all", flash_top_doctors: "7" })).ok).toBe(true);
    expect(state.upserts.at(-1)!.row).toMatchObject({ flash_share_basis: "all", flash_top_doctors: 7 });
  });
});
