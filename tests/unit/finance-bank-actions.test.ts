/**
 * Phase 20C server-action gating, with the session and the database replaced by fakes: every bank action refuses a
 * member without ITS OWN permission before the service role is created (view does not cover manage, manage does not
 * cover sign-off), the preparer cannot sign, and bad input is refused before any database call. No network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-000000000001";
const REC = "00000000-0000-4000-8000-0000000000c1";
const HASH = "a".repeat(64);

const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  writes: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  row: null as unknown,
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
    // a chainable query that records writes and resolves to state.row
    const chain = (): Record<string, unknown> => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lte", "or", "order", "range", "limit"])
        q[m] = () => q;
      for (const m of ["insert", "update", "upsert", "delete"])
        q[m] = () => {
          state.writes.push(m);
          return q;
        };
      q.maybeSingle = async () => ({ data: state.row, error: null });
      q.single = async () => ({ data: state.row, error: null });
      q.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      return q;
    };
    return {
      from: () => chain(),
      rpc: async (fn: string) => {
        state.writes.push(`rpc:${fn}`);
        return { data: null, error: null };
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
  createRun,
  decideMatch,
  deleteImport,
  importStatement,
  markReviewed,
  reopenRun,
  runMatching,
  saveReason,
  signRun,
  undoMatch,
} from "@/app/(app)/finance/bank/actions";
import {
  addStarterRules,
  deleteRule,
  saveAccount,
  saveBankSettings,
  saveFormat,
  saveRule,
} from "@/app/(app)/finance/bank/settings/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.writes = [];
  state.audits = [];
  state.row = null;
};

const fileForm = (name = "statement.csv", body = "Value Date,Amount\n05/10/2026,1") => {
  const fd = new FormData();
  fd.set("kind", "bank_statement");
  fd.set("format_id", "00000000-0000-4000-8000-0000000000f1");
  fd.set("account_id", "00000000-0000-4000-8000-0000000000a1");
  fd.set("file", new File([body], name));
  return fd;
};

const pair = {
  rec_id: REC,
  key: "col|Card|2026-10-01",
  line_id: "00000000-0000-4000-8000-000000000101",
};
const MANAGE_ACTIONS: Array<[string, () => Promise<{ ok: boolean }>]> = [
  ["importStatement", () => importStatement(fileForm())],
  ["deleteImport", () => deleteImport({ id: REC })],
  ["createRun", () => createRun({ account_id: REC, month: "2026-10" })],
  ["runMatching", () => runMatching({ rec_id: REC })],
  ["decideMatch", () => decideMatch({ ...pair, decision: "accept" })],
  ["undoMatch", () => undoMatch(pair)],
  ["saveReason", () => saveReason({ rec_id: REC, item_key: pair.key, code: "in_transit" })],
  ["markReviewed", () => markReviewed({ rec_id: REC })],
  ["reopenRun", () => reopenRun({ rec_id: REC })],
  [
    "saveAccount",
    () => saveAccount({ name: "Ops", bank_name: "Bank", last4: "1234", currency: "AED" }),
  ],
  [
    "saveFormat",
    () =>
      saveFormat({
        kind: "bank_statement",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_value_date: "D",
        col_amount: "A",
      }),
  ],
  ["saveRule", () => saveRule({ payment_mode: "Card", lag_days: "2", fee_pct: "2" })],
  ["deleteRule", () => deleteRule({ id: REC })],
  ["addStarterRules", () => addStarterRules()],
  [
    "saveBankSettings",
    () =>
      saveBankSettings({
        bank_date_window_days: "3",
        bank_amount_tolerance: "1",
        bank_amount_tolerance_pct: "0",
        bank_auto_accept_score: "80",
        bank_cutoff_day: "30",
      }),
  ],
];

describe("bank reconciliation actions", () => {
  beforeEach(() => as());

  it("refuse a member without finance.bank.manage before the service role exists (view and sign-off do not cover it)", async () => {
    for (const perms of [
      [],
      ["finance.bank.view"],
      ["finance.bank.signoff"],
      ["finance.cashup.manage", "finance.remittance.manage"],
    ]) {
      as(...perms);
      for (const [name, run] of MANAGE_ACTIONS)
        expect((await run()).ok, `${name} with ${perms.join(",")}`).toBe(false);
      expect(state.adminCalls).toBe(0);
      expect(state.audits).toHaveLength(0);
    }
  });

  it("the sign-off needs finance.bank.signoff; manage does not cover it", async () => {
    as("finance.bank.manage", "finance.bank.view");
    expect(await signRun({ rec_id: REC, hash: HASH })).toEqual({
      ok: false,
      error: "You do not have permission for that.",
    });
    expect(state.adminCalls).toBe(0);
  });

  it("the preparer cannot sign, and a changed fingerprint is refused, without writing anything", async () => {
    as("finance.bank.signoff");
    state.row = { status: "reviewed", prepared_by: USER, figures_sha256: HASH };
    const own = await signRun({ rec_id: REC, hash: HASH });
    expect(own).toMatchObject({
      ok: false,
      error: expect.stringMatching(/another person must sign/),
    });
    state.row = {
      status: "reviewed",
      prepared_by: "00000000-0000-4000-8000-000000000009",
      figures_sha256: "b".repeat(64),
    };
    expect(await signRun({ rec_id: REC, hash: HASH })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/figures changed/),
    });
    expect(await signRun({ rec_id: REC, hash: "not-a-hash" })).toMatchObject({ ok: false });
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("a different signer reaches the single guarded update", async () => {
    as("finance.bank.signoff");
    state.row = {
      status: "reviewed",
      prepared_by: "00000000-0000-4000-8000-000000000009",
      figures_sha256: HASH,
    };
    // the fake update returns no rows, so the action reports it could not sign: the write was attempted once
    const r = await signRun({ rec_id: REC, hash: HASH });
    expect(state.writes).toEqual(["update"]);
    expect(r.ok).toBe(false);
  });

  it("refuses a file that is too large or not .csv / .xlsx before touching the database", async () => {
    as("finance.bank.manage");
    expect(await importStatement(fileForm("statement.pdf"))).toMatchObject({
      ok: false,
      error: "Upload a .csv or .xlsx file.",
    });
    const big = fileForm("big.csv", "x".repeat(5 * 1024 * 1024 + 1));
    expect(await importStatement(big)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/larger than 5 MB/),
    });
    expect(state.adminCalls).toBe(0);
  });

  it("refuses an incomplete layout, a bad reason and a bad account before touching the database", async () => {
    as("finance.bank.manage");
    expect(
      await saveFormat({
        kind: "bank_statement",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_value_date: "Date",
      }),
    ).toMatchObject({
      ok: false,
      error: 'Give the column header for "Amount (signed)".',
    });
    expect(await saveReason({ rec_id: REC, item_key: pair.key, code: "made_up" })).toMatchObject({
      ok: false,
    });
    expect(await saveReason({ rec_id: REC, item_key: pair.key, code: "other" })).toMatchObject({
      ok: false,
      error: "Explain the reason in the note.",
    });
    expect(
      await saveAccount({ name: "Ops", bank_name: "Bank", last4: "AE07 0331", currency: "AED" }),
    ).toMatchObject({ ok: false });
    expect(
      await saveBankSettings({
        bank_date_window_days: "3",
        bank_amount_tolerance: "1",
        bank_amount_tolerance_pct: "0",
        bank_auto_accept_score: "10",
        bank_cutoff_day: "30",
      }),
    ).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });
});
