/**
 * Slice 20E server-action gating, with the session and the database replaced by fakes: every labs action refuses a
 * member without finance.labs.manage before the service role is created (view, bank and revenue-share keys do not cover
 * it), the person who reviewed cannot post, a changed fingerprint is refused, bad input is refused before any database
 * call, and the bank and lab layout actions each refuse the other's kinds. No network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-000000000001";
const ST = "00000000-0000-4000-8000-0000000000c1";
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
        return { data: { added: 1, removed: 0 }, error: null };
      },
    };
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));

import { saveFormat } from "@/app/(app)/finance/bank/settings/actions";
import {
  importProviderFile,
  postStatement,
  removeProviderFile,
  reopenStatement,
  reviewStatement,
  saveLabReason,
} from "@/app/(app)/finance/labs/actions";
import {
  deleteProviderTest,
  saveLabFormat,
  saveLabSettings,
  saveProvider,
  saveProviderTests,
} from "@/app/(app)/finance/labs/settings/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.writes = [];
  state.audits = [];
  state.row = null;
};

const fileForm = (name = "lab.csv", body = "Date,Code\n2026-10-05,85025") => {
  const fd = new FormData();
  fd.set("provider_id", "00000000-0000-4000-8000-0000000000a1");
  fd.set("format_id", "00000000-0000-4000-8000-0000000000f1");
  fd.set("month", "2026-10");
  fd.set("file", new File([body], name));
  return fd;
};

const ACTIONS: Array<[string, () => Promise<{ ok: boolean }>]> = [
  ["importProviderFile", () => importProviderFile(fileForm())],
  ["removeProviderFile", () => removeProviderFile({ statement_id: ST, file_id: ST })],
  [
    "saveLabReason",
    () => saveLabReason({ statement_id: ST, item_key: `line|${ST}`, code: "provider_error" }),
  ],
  ["reviewStatement", () => reviewStatement({ statement_id: ST })],
  ["postStatement", () => postStatement({ statement_id: ST, hash: HASH })],
  ["reopenStatement", () => reopenStatement({ statement_id: ST })],
  ["saveProvider", () => saveProvider({ name: "Synthetic Lab", kind: "send_out_lab" })],
  ["saveProviderTests", () => saveProviderTests({ provider_id: ST, list: "85025, 1, 35" })],
  ["deleteProviderTest", () => deleteProviderTest({ id: ST })],
  [
    "saveLabFormat",
    () =>
      saveLabFormat({
        kind: "lab_activity",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_service_date: "D",
        col_test_code: "C",
      }),
  ],
  [
    "saveLabSettings",
    () => saveLabSettings({ lab_date_window_days: "2", lab_price_tolerance: "1" }),
  ],
];

describe("labs actions", () => {
  beforeEach(() => as());

  it("refuse a member without finance.labs.manage before the service role exists", async () => {
    for (const perms of [
      [],
      ["finance.labs.view"],
      ["finance.bank.manage", "finance.bank.view"],
      ["finance.revshare.manage", "finance.revshare.view"],
    ]) {
      as(...perms);
      for (const [name, run] of ACTIONS)
        expect((await run()).ok, `${name} with ${perms.join(",")}`).toBe(false);
      expect(state.adminCalls).toBe(0);
      expect(state.audits).toHaveLength(0);
    }
  });

  it("the person who reviewed cannot post, and a changed fingerprint is refused, without writing", async () => {
    as("finance.labs.manage");
    state.row = { status: "reviewed", prepared_by: USER, figures_sha256: HASH };
    expect(await postStatement({ statement_id: ST, hash: HASH })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/another person must post/),
    });
    state.row = {
      status: "reviewed",
      prepared_by: "00000000-0000-4000-8000-000000000009",
      figures_sha256: "b".repeat(64),
    };
    expect(await postStatement({ statement_id: ST, hash: HASH })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/figures changed/),
    });
    state.row = { status: "open", prepared_by: null, figures_sha256: null };
    expect(await postStatement({ statement_id: ST, hash: HASH })).toMatchObject({ ok: false });
    expect(await postStatement({ statement_id: ST, hash: "nope" })).toMatchObject({ ok: false });
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("a different person reaches the posting function once, audited", async () => {
    as("finance.labs.manage");
    state.row = {
      status: "reviewed",
      prepared_by: "00000000-0000-4000-8000-000000000009",
      figures_sha256: HASH,
    };
    expect(await postStatement({ statement_id: ST, hash: HASH })).toMatchObject({ ok: true });
    expect(state.writes).toEqual(["rpc:fin_lab_post"]);
    expect(state.audits.map((a) => a.action)).toEqual(["finance.labs.posted"]);
  });

  it("refuses bad files and input before touching the database", async () => {
    as("finance.labs.manage");
    expect(await importProviderFile(fileForm("lab.pdf"))).toMatchObject({
      ok: false,
      error: "Upload a .csv or .xlsx file.",
    });
    expect(
      await importProviderFile(fileForm("big.csv", "x".repeat(5 * 1024 * 1024 + 1))),
    ).toMatchObject({
      ok: false,
      error: expect.stringMatching(/larger than 5 MB/),
    });
    const noMonth = fileForm();
    noMonth.set("month", "October");
    expect(await importProviderFile(noMonth)).toMatchObject({
      ok: false,
      error: "Choose the month.",
    });
    expect(
      await saveLabReason({ statement_id: ST, item_key: `line|${ST}`, code: "made_up" }),
    ).toMatchObject({ ok: false });
    expect(
      await saveLabReason({ statement_id: ST, item_key: `line|${ST}`, code: "other" }),
    ).toMatchObject({ ok: false, error: "Explain the reason in the note." });
    expect(await saveProvider({ name: "X", kind: "pharmacy" })).toMatchObject({ ok: false });
    expect(
      await saveProvider({ name: "X", kind: "in_house_lab", fixed_monthly_fee: "-5" }),
    ).toMatchObject({ ok: false });
    expect(await saveProviderTests({ provider_id: ST, list: "Layla Demo-07, 1, 2" })).toMatchObject(
      {
        ok: false,
        error: "Line 1: the code is not a CPT or item code.",
      },
    );
    expect(
      await saveLabSettings({ lab_date_window_days: "30", lab_price_tolerance: "1" }),
    ).toMatchObject({ ok: false });
    expect(
      await saveLabFormat({
        kind: "lab_activity",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_test_code: "C",
      }),
    ).toMatchObject({ ok: false, error: 'Give the column header for "Service (sample) date".' });
    expect(state.adminCalls).toBe(0);
  });

  it("each settings page saves only its own layout kinds", async () => {
    as("finance.labs.manage", "finance.bank.manage");
    expect(
      await saveLabFormat({
        kind: "bank_statement",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_value_date: "D",
        col_amount: "A",
      }),
    ).toMatchObject({ ok: false, error: "Choose the kind of file." });
    expect(
      await saveFormat({
        kind: "lab_activity",
        name: "X",
        date_format: "DD/MM/YYYY",
        col_service_date: "D",
        col_test_code: "C",
      }),
    ).toMatchObject({ ok: false, error: "Choose the kind of file." });
    expect(state.adminCalls).toBe(0);
  });
});
