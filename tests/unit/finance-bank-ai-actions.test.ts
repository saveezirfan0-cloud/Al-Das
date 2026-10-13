/**
 * Phase 20H server actions with the session, the database, the AI gates and the model replaced by fakes (no network):
 * asking for a review needs finance.bank.manage AND finance.bank.ai before anything else happens, an open run, and the
 * workspace AI gates; the fake model's answer is checked and stored as a draft review with pending suggestions, and the
 * calls are recorded (tokens only). Accepting a suggested pair goes through the same insert, audit and checks as a person
 * accepting a 20C proposal; rejecting only records the decision.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Llm, LlmRequest, LlmResult } from "@/lib/ai/llm";
import { reconcileRun, type BankLine, type SettlementRule } from "@/lib/finance/bank-recon";

import fx from "./finance/fixtures/bank.synthetic.json";

const REC = "00000000-0000-4000-8000-0000000000c1";
const REVIEW = "00000000-0000-4000-8000-0000000000d1";
const SUGG = "00000000-0000-4000-8000-0000000000e1";
const L = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

type Op = { table: string; op: string; payload?: unknown };
const state = vi.hoisted(() => ({
  permissions: [] as string[],
  adminCalls: 0,
  ops: [] as Op[],
  audits: [] as Array<Record<string, unknown>>,
  runStatus: "open",
  suggestion: null as null | Record<string, unknown>,
  copilot: { ok: true } as { ok: boolean; error?: string },
  replies: [] as string[],
  prompts: [] as LlmRequest[],
  recorded: [] as Array<{ feature: string; calls: unknown[] }>,
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
    const chain = (table: string): Record<string, unknown> => {
      let last = "select";
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "gte", "lte", "or", "order", "range", "limit"])
        q[m] = () => q;
      for (const m of ["insert", "update", "upsert", "delete"])
        q[m] = (payload?: unknown) => {
          last = m;
          state.ops.push({ table, op: m, payload });
          return q;
        };
      const one = () => {
        if (table === "fin_bank_recs") return { id: REC, status: state.runStatus };
        if (table === "fin_bank_ai_reviews" && last === "insert") return { id: REVIEW };
        if (table === "fin_bank_ai_suggestions") return state.suggestion;
        return null;
      };
      q.maybeSingle = async () => ({ data: one(), error: null });
      q.single = async () => ({ data: one(), error: null });
      q.then = (res: (v: unknown) => unknown) =>
        res({ data: last === "update" ? [{ id: SUGG }] : [], error: null });
      return q;
    };
    return { from: (t: string) => chain(t), rpc: async () => ({ data: null, error: null }) };
  },
}));
vi.mock("@/lib/audit", () => ({
  recordAudit: async (_a: unknown, e: Record<string, unknown>) => {
    state.audits.push(e);
  },
}));
vi.mock("@/lib/ai/copilot/server", () => ({
  openCopilot: async () => {
    if (!state.copilot.ok) return { ok: false, error: state.copilot.error };
    let i = 0;
    const llm: Llm = {
      model: "fake-model",
      complete: async (req: LlmRequest): Promise<LlmResult> => {
        state.prompts.push(req);
        return {
          text: state.replies[Math.min(i++, state.replies.length - 1)] ?? "",
          inputTokens: 500,
          outputTokens: 80,
          refused: false,
          servedBy: "fake-model",
        };
      },
    };
    return { ok: true, admin: {}, llm, clinicName: "Test", settings: { daily_cap: 0 } };
  },
  recordCalls: async (_o: unknown, _m: unknown, feature: string, calls: unknown[]) => {
    state.recorded.push({ feature, calls });
  },
  describeProviderFailure: () => "The AI assistant hit a problem. Please try again.",
}));

// The run: the synthetic October of the 20C tests, computed by the real pure rules.
const ACC = fx.accounts as Record<"OPS" | "INS", string>;
const rules: Array<SettlementRule & { id: string }> = fx.rules.map((r, i) => ({
  id: `rule-${i}`,
  mode: r.mode,
  lagDays: r.lagDays,
  feePct: r.feePct,
  accountId: r.account ? ACC[r.account as "OPS" | "INS"] : null,
  settlesToBank: r.settlesToBank,
  source: r.source as "collections" | "settlement",
}));
vi.mock("@/lib/finance/bank-server", () => ({
  loadSettlementRules: async () => rules,
  loadBankSettings: async () => fx.settings,
  loadRun: async () => {
    const lines = fx.lines.OPS as BankLine[];
    return {
      rec: {
        id: REC,
        account_id: ACC.OPS,
        month: "2026-10-01",
        period_start: fx.period.start,
        period_end: fx.period.end,
        status: state.runStatus,
        figures_sha256: null,
        prepared_by: null,
        prepared_at: null,
        signed_by: null,
        signed_at: null,
      },
      account: {
        id: ACC.OPS,
        name: "Ops",
        bank_name: "Bank",
        last4: "4321",
        currency: "AED",
        receives_insurance: false,
      },
      settings: fx.settings,
      lines: new Map(lines.map((l) => [l.id, l])),
      result: reconcileRun({
        accountId: ACC.OPS,
        receivesInsurance: false,
        period: fx.period,
        rules,
        settings: fx.settings,
        collections: fx.collections,
        settlements: fx.settlements,
        remittances: fx.remittances,
        lines,
        matchedElsewhere: new Set(fx.matchedElsewhere),
        decisions: [],
        notes: [],
        today: fx.today,
        statementEnd: fx.statementEnd,
      }),
    };
  },
}));

import { askAiReview, decideAiSuggestion } from "@/app/(app)/finance/bank/actions";

const as = (...p: string[]) => {
  state.permissions = p;
  state.adminCalls = 0;
  state.ops = [];
  state.audits = [];
  state.runStatus = "open";
  state.suggestion = null;
  state.copilot = { ok: true };
  state.replies = [];
  state.prompts = [];
  state.recorded = [];
};
const BOTH = ["finance.bank.manage", "finance.bank.ai"];
const good = JSON.stringify({
  suggestions: [
    { item: "E1", candidate: "L1", reason: "fee_deducted", confidence: "medium" },
    { item: "E2", candidate: null, reason: "no_match_likely_missing", confidence: "low" },
  ],
  summary: "E1 is 0.50 short: a fee. E2 (cash, 300) has not arrived.",
});
const writes = () => state.ops.map((o) => `${o.op}:${o.table}`);

describe("askAiReview", () => {
  beforeEach(() => as());

  it("refuses without finance.bank.manage AND finance.bank.ai, before the service role or the model", async () => {
    for (const perms of [
      [],
      ["finance.bank.manage"],
      ["finance.bank.ai"],
      ["finance.bank.view", "finance.bank.ai"],
      ["finance.bank.signoff", "finance.bank.ai"],
      ["flows.ai", "campaigns.ai", "finance.bank.manage"],
    ]) {
      as(...perms);
      expect(await askAiReview({ rec_id: REC }), perms.join(",")).toEqual({
        ok: false,
        error: "You do not have permission for that.",
      });
      expect(state.adminCalls).toBe(0);
      expect(state.prompts).toHaveLength(0);
    }
  });

  it("refuses when AI is off for the workspace, without calling the model or writing", async () => {
    as(...BOTH);
    state.copilot = { ok: false, error: "AI is turned off for this workspace." };
    expect(await askAiReview({ rec_id: REC })).toEqual({
      ok: false,
      error: "AI is turned off for this workspace.",
    });
    expect(state.prompts).toHaveLength(0);
    expect(writes()).toEqual([]);
    expect(state.recorded).toEqual([]);
  });

  it("refuses a run that is not open before the AI gates (no limit is spent)", async () => {
    as(...BOTH);
    state.runStatus = "reviewed";
    state.copilot = { ok: false, error: "should not be reached" };
    expect(await askAiReview({ rec_id: REC })).toEqual({
      ok: false,
      error: "This reconciliation is not open.",
    });
    expect(state.prompts).toHaveLength(0);
    expect(writes()).toEqual([]);
    expect(await askAiReview({ rec_id: "not-a-uuid" })).toMatchObject({ ok: false });
  });

  it("end to end: stores the checked answer as a draft review with pending suggestions, tokens recorded, audited", async () => {
    as(...BOTH);
    state.replies = [good];
    const r = await askAiReview({ rec_id: REC });
    expect(r).toMatchObject({ ok: true });
    // the model saw aliases and no description
    const user = state.prompts[0]!.user;
    expect(user).toContain('"id":"E1"');
    expect(user).not.toMatch(/CARD SETTLEMENT|TRANSFER FROM|00000000-0000/);
    expect(writes()).toEqual(["insert:fin_bank_ai_reviews", "insert:fin_bank_ai_suggestions"]);
    expect(state.ops[0].payload).toMatchObject({
      rec_id: REC,
      status: "ok",
      model: "fake-model",
      summary: "E1 is 0.50 short: a fee. E2 (cash, 300) has not arrived.",
      item_count: 5,
      suggestion_count: 2,
      repaired: false,
    });
    expect(state.ops[1].payload).toEqual([
      expect.objectContaining({
        review_id: REVIEW,
        item_key: "col|Card|2026-10-02",
        candidate_line_id: L(102),
        reason_code: "fee_deducted",
        confidence: "medium",
      }),
      expect.objectContaining({
        item_key: "col|Cash|2026-10-06",
        candidate_line_id: null,
        reason_code: "no_match_likely_missing",
      }),
    ]);
    // no decision is made for anyone: nothing touches matches, reasons or the run
    expect(writes().some((w) => /fin_bank_(matches|rec_notes|recs)/.test(w))).toBe(false);
    expect(state.recorded).toEqual([
      {
        feature: "bank_review",
        calls: [expect.objectContaining({ inputTokens: 500, status: "ok" })],
      },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: "finance.bank.ai_reviewed",
        entityId: REVIEW,
        diff: { rec: REC, status: "ok", suggestions: 2, repaired: false },
      }),
    ]);
  });

  it("an answer that fails the checks twice is stored as rejected with the reasons, and nothing is suggested", async () => {
    as(...BOTH);
    const invented = JSON.stringify({
      suggestions: [{ item: "E1", candidate: "L7", reason: "amount_and_date", confidence: "high" }],
      summary: "x",
    });
    state.replies = [invented, invented];
    const r = await askAiReview({ rec_id: REC });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/rejected by the checks/) });
    expect(state.prompts).toHaveLength(2);
    expect(writes()).toEqual(["insert:fin_bank_ai_reviews"]);
    expect(state.ops[0].payload).toMatchObject({
      status: "rejected",
      summary: null,
      suggestion_count: 0,
      reject_reason: "Suggestion 1: the candidate is not on that item's own candidate list.",
    });
    expect(state.recorded[0].calls).toHaveLength(2);
    expect(state.audits[0]).toMatchObject({
      diff: expect.objectContaining({ status: "rejected" }),
    });
  });
});

describe("decideAiSuggestion", () => {
  beforeEach(() => as());
  const pending = (candidate: string | null, key = "col|Card|2026-10-02") => ({
    id: SUGG,
    rec_id: REC,
    item_key: key,
    candidate_line_id: candidate,
    decision: "pending",
  });

  it("refuses without both permissions before the service role", async () => {
    for (const perms of [["finance.bank.manage"], ["finance.bank.ai"], []]) {
      as(...perms);
      expect(
        (await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "accept" })).ok,
      ).toBe(false);
      expect(state.adminCalls).toBe(0);
    }
    as(...BOTH);
    expect(
      await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "maybe" }),
    ).toMatchObject({ ok: false });
    expect(state.adminCalls).toBe(0);
  });

  it("accepting a pair saves the match through the 20C path (same row and audit as a person's accept), then marks it", async () => {
    as(...BOTH);
    state.suggestion = pending(L(102));
    const r = await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "accept" });
    expect(r).toMatchObject({ ok: true });
    expect(writes()).toEqual(["insert:fin_bank_matches", "update:fin_bank_ai_suggestions"]);
    expect(state.ops[0].payload).toMatchObject({
      rec_id: REC,
      bank_line_id: L(102),
      expected_key: "col|Card|2026-10-02",
      expected_amount: 1852.5,
      bank_amount: 1852,
      score: 67,
      status: "matched",
      auto: false,
    });
    expect(state.ops[1].payload).toMatchObject({ decision: "accepted" });
    expect(state.audits.map((a) => a.action)).toEqual([
      "finance.bank.match_accepted",
      "finance.bank.ai_suggestion_accepted",
    ]);
  });

  it("refuses when the pair is no longer a candidate or the run is not open, and marks nothing", async () => {
    as(...BOTH);
    state.suggestion = pending(L(103)); // L(103) is not a candidate of the Card item
    expect(
      await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "accept" }),
    ).toEqual({ ok: false, error: "That pair is no longer a candidate. Reload the page." });
    state.suggestion = pending(L(102));
    state.runStatus = "signed";
    expect(
      await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "accept" }),
    ).toEqual({ ok: false, error: "This reconciliation is not open." });
    expect(writes()).toEqual([]);
    state.suggestion = { ...pending(L(102)), decision: "accepted" };
    expect(
      await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "reject" }),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/already been decided/) });
    expect(state.audits).toEqual([]);
  });

  it("rejecting only records the decision; the pair stays open for a person", async () => {
    as(...BOTH);
    state.suggestion = pending(L(102));
    const r = await decideAiSuggestion({ rec_id: REC, suggestion_id: SUGG, decision: "reject" });
    expect(r).toMatchObject({ ok: true, message: "Suggestion rejected." });
    expect(writes()).toEqual(["update:fin_bank_ai_suggestions"]);
    expect(state.audits.map((a) => a.action)).toEqual(["finance.bank.ai_suggestion_rejected"]);
  });
});
