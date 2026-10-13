/**
 * Phase 20G server-action gating, with the session and the database replaced by fakes: each action refuses a member
 * without its permission before the service role is created; an owner (finance.close.tasks) marks steps only through
 * the database's owner check (p_any_step false), a manager for any step; a blocked step needs its dependency; the audit
 * row carries codes and statuses, never the typed text. No network. Synthetic data only.
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
        return {
          data: state.rpcError
            ? null
            : fn === "fin_close_set_task_status"
              ? { month: "2026-09-01", step_code: "BANK_CASH", from: "open", to: args.p_status }
              : 3,
          error: state.rpcError,
        };
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
  addHoliday,
  createCloseTasks,
  deleteHoliday,
  saveCloseCalendar,
  saveCloseStep,
  setCloseTaskStatus,
} from "@/app/(app)/finance/close/timetable/actions";

const TASK = "00000000-0000-4000-8000-0000000000aa";
const as = (...p: string[]) => {
  state.permissions = p;
  state.rpcCalls = [];
  state.audits = [];
  state.adminCalls = 0;
  state.rpcError = null;
};

describe("close timetable actions", () => {
  beforeEach(() => as());

  it("refuses members without a close permission before the service role exists", async () => {
    for (const perms of [[], ["finance.view"], ["finance.flash.view", "finance.costs.manage"]]) {
      as(...perms);
      expect((await setCloseTaskStatus({ id: TASK, status: "done" })).ok).toBe(false);
      expect((await createCloseTasks({ month: "2026-09" })).ok).toBe(false);
      expect((await saveCloseStep({ code: "X", title: "X", due_wd: "5" })).ok).toBe(false);
    }
    expect(state.adminCalls).toBe(0);
    expect(state.audits).toHaveLength(0);
  });

  it("the template, the calendar and creating tasks need finance.close.manage, not the view or tasks key", async () => {
    as("finance.close.tasks", "finance.close.view", "finance.close.signoff.ceo");
    expect((await createCloseTasks({ month: "2026-09" })).ok).toBe(false);
    expect((await saveCloseStep({ code: "X", title: "X", due_wd: "5" })).ok).toBe(false);
    expect(
      (
        await saveCloseCalendar({
          start: "",
          inputs_wd: "5",
          deadline_wd: "10",
          item_max_age_days: "60",
        })
      ).ok,
    ).toBe(false);
    expect((await addHoliday({ holiday_on: "2026-12-02", name: "National Day" })).ok).toBe(false);
    expect((await deleteHoliday({ id: TASK })).ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it("an owner marks a step through the database owner check; a manager for any step", async () => {
    as("finance.close.tasks");
    const r = await setCloseTaskStatus({ id: TASK, status: "done", note: "in the shared folder" });
    expect(r.ok).toBe(true);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "fin_close_set_task_status",
      args: { p_task_id: TASK, p_status: "done", p_any_step: false },
    });
    as("finance.close.manage");
    await setCloseTaskStatus({ id: TASK, status: "open" });
    expect(state.rpcCalls[0].args).toMatchObject({ p_any_step: true });
  });

  it("blocked needs the dependency; the audit has codes and statuses, never the text", async () => {
    as("finance.close.tasks");
    const r = await setCloseTaskStatus({ id: TASK, status: "blocked", reason: "  " });
    expect(r.ok).toBe(false);
    expect(state.adminCalls).toBe(0);
    const ok = await setCloseTaskStatus({
      id: TASK,
      status: "blocked",
      reason: "Bank statement from the bank",
      note: "Asked on Monday",
    });
    expect(ok.ok).toBe(true);
    expect(state.rpcCalls[0].args).toMatchObject({ p_reason: "Bank statement from the bank" });
    expect(state.audits[0]).toMatchObject({
      action: "finance.close.task_status",
      entity: "fin_close_tasks",
      entityId: TASK,
      diff: { month: "2026-09-01", step: "BANK_CASH", from: "open", to: "blocked" },
    });
    expect(JSON.stringify(state.audits)).not.toMatch(/Bank statement|Monday/);
  });

  it("shows the database's refusal (not the owner, month locked) and audits nothing", async () => {
    as("finance.close.tasks");
    state.rpcError = {
      code: "42501",
      message: "only the owner or the backup of this step can change it",
    };
    const r = await setCloseTaskStatus({ id: TASK, status: "done" });
    expect(r).toEqual({
      ok: false,
      error: "only the owner or the backup of this step can change it",
    });
    expect(state.audits).toHaveLength(0);
    state.rpcError = { code: "XX000", message: "internal detail" };
    const r2 = await setCloseTaskStatus({ id: TASK, status: "done" });
    expect(r2).toEqual({ ok: false, error: "The step could not be updated." });
  });

  it("rejects bad input: unknown status, a month that has not ended, owner equal to backup", async () => {
    as("finance.close.manage");
    expect((await setCloseTaskStatus({ id: TASK, status: "skipped" })).ok).toBe(false);
    expect((await setCloseTaskStatus({ id: "nope", status: "done" })).ok).toBe(false);
    expect((await createCloseTasks({ month: "2999-01" })).ok).toBe(false);
    const same = "00000000-0000-4000-8000-0000000000bb";
    const r = await saveCloseStep({
      code: "bank_cash",
      title: "Bank",
      due_wd: "5",
      owner_user_id: same,
      backup_user_id: same,
    });
    expect(r).toEqual({
      ok: false,
      error: "The backup must be a different person from the owner.",
    });
    expect((await saveCloseStep({ code: "X", title: "X", due_wd: "24" })).ok).toBe(false);
    expect((await saveCloseStep({ code: "X", title: "X", due_wd: "5", dep_X: "on" })).ok).toBe(
      false,
    );
    expect(
      (
        await saveCloseCalendar({
          start: "",
          inputs_wd: "11",
          deadline_wd: "10",
          item_max_age_days: "60",
        })
      ).ok,
    ).toBe(false);
    // the Board pack thresholds (Phase 20G part 2) are validated the same way
    const calendar = {
      start: "",
      inputs_wd: "5",
      deadline_wd: "10",
      item_max_age_days: "60",
      revshare_wd: "7",
      voucher_unpaid_days: "14",
      receivables_over90_pct: "25",
    };
    for (const bad of [
      { revshare_wd: "24" },
      { voucher_unpaid_days: "0" },
      { receivables_over90_pct: "120" },
      { receivables_over90_pct: "x" },
    ])
      expect((await saveCloseCalendar({ ...calendar, ...bad })).ok).toBe(false);
    expect(state.adminCalls).toBe(0);
  });

  it("creates a finished month's tasks in one call and audits the count", async () => {
    as("finance.close.manage");
    const r = await createCloseTasks({ month: "2026-09" });
    expect(r.ok).toBe(true);
    expect(state.rpcCalls[0]).toMatchObject({
      fn: "fin_close_generate_tasks",
      args: { p_month: "2026-09-01" },
    });
    expect(state.audits[0]).toMatchObject({
      action: "finance.close.tasks_created",
      diff: { month: "2026-09", created: 3 },
    });
  });
});
