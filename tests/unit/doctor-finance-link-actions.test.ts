/**
 * Server-action gating for the doctor drawer's Finance link, with the session and the database replaced by fakes:
 * nobody without settings.manage AND finance.reference.manage reaches the service role, the target must exist, a
 * unique clash is reported, and the audit carries ids and codes only (never the report name). No network. Synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const DOCTOR = "00000000-0000-4000-8000-0000000000d1";

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  current: { id: "", dha_id: null as string | null, report_doctor_key: null as string | null },
  finance: new Set<string>(),
  reportKeys: [] as Array<{ key: string; name: string }>,
  updateError: null as null | { code: string },
  updates: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireMember: async () => ({
    userId: "00000000-0000-4000-8000-000000000001",
    orgId: "00000000-0000-4000-8000-000000000002",
    roleId: "r",
    status: "active" as const,
    permissions: state.permissions,
    org: { name: "Test", timezone: "Asia/Dubai", settings: {}, is_training: false },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    state.adminCalls++;
    return {
      rpc: async () => ({ data: state.reportKeys, error: null }),
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        let update: Record<string, unknown> | null = null;
        const result = () => {
          if (update) {
            state.updates.push(update);
            return { data: null, error: state.updateError };
          }
          if (table === "specialists") return { data: state.current, error: null };
          if (table === "fin_ref_doctors")
            return {
              data: state.finance.has(String(filters.dha_id)) ? { dha_id: filters.dha_id } : null,
              error: null,
            };
          return { data: [], error: null }; // specialist_locations: a doctor in no branch
        };
        const chain = {
          select: () => chain,
          update: (patch: Record<string, unknown>) => ((update = patch), chain),
          eq: (col: string, v: unknown) => ((filters[col] = v), chain),
          maybeSingle: async () => result(),
          then: (resolve: (v: unknown) => unknown) => resolve(result()),
        };
        return chain;
      },
    };
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));

import {
  loadDoctorFinanceLinkAction,
  saveDoctorFinanceLinkAction,
} from "@/app/(app)/doctors/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.current = { id: DOCTOR, dha_id: null, report_doctor_key: null };
  state.finance = new Set(["DHA0001"]);
  state.reportKeys = [{ key: "layla demo-01", name: "Dr. Layla Demo-01" }];
  state.updateError = null;
  state.updates = [];
  state.audits = [];
};
const BOTH = ["settings.manage", "finance.reference.manage"];

describe("doctor finance link actions", () => {
  beforeEach(() => as());

  it("refuse without settings.manage AND finance.reference.manage, before the service role", async () => {
    for (const perms of [[], ["settings.manage"], ["finance.reference.manage", "hr.manage"]]) {
      as(...perms);
      const res = await saveDoctorFinanceLinkAction(DOCTOR, { kind: "finance", value: "DHA0001" });
      expect(res.ok).toBe(false);
      expect(state.adminCalls).toBe(0);
    }
    as("settings.manage", "finance.revenue.view");
    expect((await loadDoctorFinanceLinkAction(DOCTOR)).ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it("links a finance doctor that exists and audits the DHA ids", async () => {
    as(...BOTH);
    const res = await saveDoctorFinanceLinkAction(DOCTOR, { kind: "finance", value: "DHA0001" });
    expect(res.ok).toBe(true);
    expect(state.updates).toEqual([{ dha_id: "DHA0001" }]);
    expect(state.audits[0]).toMatchObject({
      action: "doctor.finance_link_set",
      entity: "specialist",
      entityId: DOCTOR,
      diff: { link: "finance", from: null, to: "DHA0001" },
    });
  });

  it("refuses a target that does not exist, and reports a clash", async () => {
    as(...BOTH);
    expect((await saveDoctorFinanceLinkAction(DOCTOR, { kind: "finance", value: "NOPE" })).ok).toBe(
      false,
    );
    expect(
      (await saveDoctorFinanceLinkAction(DOCTOR, { kind: "report", value: "nobody" })).ok,
    ).toBe(false);
    expect(state.updates).toEqual([]);
    state.updateError = { code: "23505" };
    const clash = await saveDoctorFinanceLinkAction(DOCTOR, { kind: "finance", value: "DHA0001" });
    expect(clash).toEqual({ ok: false, error: "That one is already linked to another doctor." });
    expect(state.audits).toEqual([]);
  });

  it("never puts the report name in the audit", async () => {
    as(...BOTH);
    expect(
      (await saveDoctorFinanceLinkAction(DOCTOR, { kind: "report", value: "layla demo-01" })).ok,
    ).toBe(true);
    state.current = { id: DOCTOR, dha_id: null, report_doctor_key: "layla demo-01" };
    expect((await saveDoctorFinanceLinkAction(DOCTOR, { kind: "report", value: null })).ok).toBe(
      true,
    );
    expect(state.updates).toEqual([
      { report_doctor_key: "layla demo-01" },
      { report_doctor_key: null },
    ]);
    expect(state.audits.map((a) => a.diff)).toEqual([
      { link: "report", change: "set" },
      { link: "report", change: "cleared" },
    ]);
    expect(JSON.stringify(state.audits)).not.toMatch(/layla/i);
  });
});
