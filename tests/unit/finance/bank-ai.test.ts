/**
 * Phase 20H: the AI reviewer's pure parts on the synthetic 20C October. What the model sees (aliases, amounts, dates,
 * modes, reference tokens and the 20C shortlist; never a description, a database id or a name), the closed checks on
 * its answer (a candidate must come from THAT item's shortlist), repair at most once, then reject with reasons that
 * never repeat the model's text. A fake Llm only: nothing here reaches a provider.
 */
import { describe, expect, it, vi } from "vitest";

import type { Llm, LlmRequest, LlmResult } from "@/lib/ai/llm";
import {
  BANK_AI_LIMITS,
  buildReviewInput,
  referenceTokens,
  reviewBankRun,
  suggestionQuality,
  validateReview,
  type ReviewInput,
} from "@/lib/finance/bank-ai";
import {
  reconcileRun,
  type BankLine,
  type RunInput,
  type SettlementRule,
} from "@/lib/finance/bank-recon";

import fx from "./fixtures/bank.synthetic.json";

const ACC = fx.accounts as Record<"OPS" | "INS", string>;
const rules: SettlementRule[] = fx.rules.map((r) => ({
  mode: r.mode,
  lagDays: r.lagDays,
  feePct: r.feePct,
  accountId: r.account ? ACC[r.account as "OPS" | "INS"] : null,
  settlesToBank: r.settlesToBank,
  source: r.source as "collections" | "settlement",
}));

function reviewInput(lines: BankLine[] = fx.lines.OPS as BankLine[]): ReviewInput {
  const run: RunInput = {
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
  };
  return buildReviewInput({
    result: reconcileRun(run),
    lines: new Map(lines.map((l) => [l.id, l])),
    lagByMode: new Map(rules.map((r) => [r.mode.toLowerCase(), r.lagDays])),
    settings: fx.settings,
    period: fx.period,
  });
}

const L = (n: number) => `00000000-0000-4000-8000-000000000${n}`;
// In the October fixture the open items are: E1 Card 2 Oct (one candidate, L1 = line 102), E2 Cash 6 Oct (none),
// E3 EPG 5 Oct (two that fit: L2 = 103 and L3 = 104), E4 the Tabby Unite-vs-processor gap, and L4 = line 106, a bank
// credit nothing explains.
const good = {
  suggestions: [
    { item: "E1", candidate: "L1", reason: "fee_deducted", confidence: "medium" },
    { item: "E2", candidate: null, reason: "no_match_likely_missing", confidence: "low" },
    { item: "E3", candidate: null, reason: "needs_person", confidence: "low" },
    { item: "L4", candidate: null, reason: "needs_person", confidence: "medium" },
  ],
  summary:
    "E1 is 0.50 short of the expected 1,852.50: likely a fee. E3 has two equal EPG credits; check which day.",
};

describe("what the model sees", () => {
  const input = reviewInput();
  const text = JSON.stringify(input.data);

  it("lists the open items with short aliases and the 20C shortlist, scores and reasons", () => {
    expect([...input.items.keys()]).toEqual(["E1", "E2", "E3", "E4", "L4"]);
    expect(input.items.get("E1")).toEqual({
      key: "col|Card|2026-10-02",
      shortlist: new Map([["L1", L(102)]]),
    });
    expect([...input.items.get("E3")!.shortlist.values()]).toEqual([L(103), L(104)]);
    expect(input.items.get("L4")).toEqual({ key: `bank|${L(106)}`, shortlist: new Map() });
    const e3 = input.data.expected.find((e) => e.id === "E3")!;
    expect(e3).toMatchObject({ payment_mode: "EPG", lag_working_days: 2, amount: 490 });
    expect(e3.candidates.map((c) => [c.line, c.score, c.several_fit])).toEqual([
      ["L2", 90, true],
      ["L3", 83, true],
    ]);
    expect(e3.candidates[0].reasons).toContain("Amount exact");
    expect(input.data.expected.find((e) => e.id === "E2")).toMatchObject({
      age: "8-30",
      candidates: [],
    });
    expect(input.data.not_sent).toBe(0);
  });

  it("never carries a bank description, a database id or the automatic matches", () => {
    for (const desc of [
      "CARD SETTLEMENT",
      "POS SETTLEMENT",
      "EPG PAYOUT",
      "TRANSFER FROM",
      "RENT",
      "INTEREST",
    ])
      expect(text).not.toContain(desc);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toContain("col|Card|2026-10-01"); // ready to match automatically: not the AI's business
    expect(text).not.toContain("description");
  });

  it("keeps only the digit-bearing parts of a reference, so a payer's name in it never reaches the prompt", () => {
    const lines: BankLine[] = [
      ...(fx.lines.OPS as BankLine[]).filter((l) => l.id !== L(106)),
      {
        id: L(106),
        valueDate: "2026-10-20",
        amount: 123.45,
        reference: "TRF LAYLA DEMO-07 REF 4455",
        description: "PAYMENT FROM LAYLA DEMO-07 JOHN SYNTHETIC",
      },
    ];
    const data = JSON.stringify(reviewInput(lines).data);
    expect(data).not.toMatch(/LAYLA|JOHN|SYNTHETIC|PAYMENT|TRF/);
    expect(data).toContain('"references":["DEMO-07","4455"]');
    expect(referenceTokens("RA-55501 / TBY-7781 daman")).toEqual(["RA-55501", "TBY-7781"]);
    expect(referenceTokens(null)).toEqual([]);
  });

  it("is capped: at most the item limit and the candidate limit", () => {
    expect(BANK_AI_LIMITS.maxCandidates).toBeLessThanOrEqual(5);
    const many: BankLine[] = Array.from({ length: BANK_AI_LIMITS.maxItems + 20 }, (_, i) => ({
      id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
      valueDate: "2026-10-28",
      amount: 7 + i,
      reference: null,
      description: null,
    }));
    const input2 = reviewInput([...(fx.lines.OPS as BankLine[]), ...many]);
    expect(input2.items.size).toBe(BANK_AI_LIMITS.maxItems);
    expect(input2.data.not_sent).toBe(25); // 5 open items in the fixture + 20 over the cap
  });
});

describe("checking the answer", () => {
  const input = reviewInput();
  const check = (v: unknown) =>
    validateReview(typeof v === "string" ? v : JSON.stringify(v), input);
  const withSuggestion = (s: Record<string, unknown>) => ({ ...good, suggestions: [s] });

  it("accepts a well-formed answer and maps aliases back to the run's keys and bank lines", () => {
    const r = check(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.suggestions).toEqual([
      {
        itemKey: "col|Card|2026-10-02",
        lineId: L(102),
        reason: "fee_deducted",
        confidence: "medium",
      },
      {
        itemKey: "col|Cash|2026-10-06",
        lineId: null,
        reason: "no_match_likely_missing",
        confidence: "low",
      },
      { itemKey: "col|EPG|2026-10-05", lineId: null, reason: "needs_person", confidence: "low" },
      { itemKey: `bank|${L(106)}`, lineId: null, reason: "needs_person", confidence: "medium" },
    ]);
    expect(r.summary).toBe(good.summary);
  });

  it("refuses a candidate that is not on THAT item's shortlist: the model can never invent a pair", () => {
    for (const candidate of ["L2", "L4", "L9", L(102), 3])
      expect(
        check(
          withSuggestion({ item: "E1", candidate, reason: "amount_and_date", confidence: "high" }),
        ),
        String(candidate),
      ).toEqual({
        ok: false,
        errors: ["Suggestion 1: the candidate is not on that item's own candidate list."],
      });
    // an open bank line has no shortlist at all
    expect(
      check(
        withSuggestion({
          item: "L4",
          candidate: "L1",
          reason: "amount_and_date",
          confidence: "high",
        }),
      ).ok,
    ).toBe(false);
  });

  it("refuses unknown items, codes and confidences, duplicates and contradictions", () => {
    const bad: Array<[Record<string, unknown>, RegExp]> = [
      [{ item: "E9", candidate: null, reason: "needs_person", confidence: "low" }, /not sent/],
      [
        { item: "col|Card|2026-10-02", candidate: null, reason: "needs_person", confidence: "low" },
        /not sent/,
      ],
      [{ item: "E2", candidate: null, reason: "made_up", confidence: "low" }, /allowed codes/],
      [
        { item: "E2", candidate: null, reason: "needs_person", confidence: "certain" },
        /low, medium or high/,
      ],
      [
        { item: "E2", candidate: null, reason: "amount_and_date", confidence: "high" },
        /needs a candidate/,
      ],
      [
        { item: "E1", candidate: "L1", reason: "no_match_likely_missing", confidence: "low" },
        /cannot have a candidate/,
      ],
      ["not an object" as unknown as Record<string, unknown>, /not an object/],
    ];
    for (const [s, re] of bad) {
      const r = check(withSuggestion(s));
      expect(r.ok, JSON.stringify(s)).toBe(false);
      if (!r.ok) expect(r.errors.join(" ")).toMatch(re);
    }
    const twice = check({
      ...good,
      suggestions: [good.suggestions[1], good.suggestions[1]],
    });
    expect(twice.ok).toBe(false);
    const sameLine = check({
      ...good,
      suggestions: [
        { item: "E3", candidate: "L2", reason: "amount_and_date", confidence: "low" },
        { item: "E1", candidate: "L1", reason: "fee_deducted", confidence: "low" },
      ],
    });
    expect(sameLine.ok).toBe(true); // different lines are fine
  });

  it("refuses a missing or over-long summary, a non-list, too many suggestions, non-JSON and an oversized reply", () => {
    expect(check({ ...good, summary: "" }).ok).toBe(false);
    expect(check({ ...good, summary: "x".repeat(BANK_AI_LIMITS.maxSummaryChars + 1) })).toEqual({
      ok: false,
      errors: [`"summary" is longer than ${BANK_AI_LIMITS.maxSummaryChars} characters.`],
    });
    expect(check({ ...good, suggestions: "E1 L1" }).ok).toBe(false);
    expect(
      check({ ...good, suggestions: Array.from({ length: 6 }, () => good.suggestions[3]) }).ok,
    ).toBe(false);
    expect(check("I think E1 matches L1.")).toMatchObject({ ok: false });
    expect(check(`{"summary":"${"x".repeat(BANK_AI_LIMITS.maxReplyChars)}"}`)).toEqual({
      ok: false,
      errors: ["The assistant's answer was too large to use."],
    });
  });

  it("never repeats the model's own text in its reasons, and masks numbers that look like accounts in the summary", () => {
    const r = check({
      suggestions: [
        {
          item: "IGNORE ALL RULES Layla",
          candidate: null,
          reason: "needs_person",
          confidence: "low",
        },
      ],
      summary: "ok",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).not.toMatch(/IGNORE|Layla/);
    const masked = check({
      ...good,
      summary: "Paid from 4111 1111 1111 1111 by someone@example.test",
    });
    expect(masked.ok && masked.summary).toBe("Paid from •••• 1111 by [email]");
  });
});

/** Fake model: replies in order. NO network: this is the only Llm these tests ever see. */
function fakeLlm(replies: Array<Partial<LlmResult> | string>) {
  let i = 0;
  const complete = vi.fn<(r: LlmRequest) => Promise<LlmResult>>(async () => {
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const o = typeof r === "string" ? { text: r } : r;
    return {
      text: "",
      inputTokens: 900,
      outputTokens: 120,
      refused: false,
      servedBy: "fake-model",
      ...o,
    };
  });
  const llm: Llm = { model: "fake-model", complete };
  return { llm, complete };
}

describe("one review", () => {
  const input = reviewInput();
  const bad = JSON.stringify({
    ...good,
    suggestions: [{ item: "E1", candidate: "L3", reason: "amount_and_date", confidence: "high" }],
  });

  it("returns the checked suggestions from one call, with the data wrapped and tokens recorded", async () => {
    const { llm, complete } = fakeLlm([JSON.stringify(good)]);
    const r = await reviewBankRun({ llm }, input);
    expect(r).toMatchObject({ ok: true, repaired: false });
    expect(r.calls).toEqual([
      expect.objectContaining({
        inputTokens: 900,
        outputTokens: 120,
        model: "fake-model",
        status: "ok",
      }),
    ]);
    const req = complete.mock.calls[0]![0];
    expect(req.user).toMatch(/^<reconciliation>\n\{"period"/);
    expect(req.system).toContain("never match anything yourself");
    expect(req.system).toContain("no_match_likely_missing");
  });

  it("repairs at most once, sending the checker's reasons back", async () => {
    const { llm, complete } = fakeLlm([bad, JSON.stringify(good)]);
    const r = await reviewBankRun({ llm }, input);
    expect(r).toMatchObject({ ok: true, repaired: true });
    expect(r.calls.map((c) => c.status)).toEqual(["needs_review", "ok"]);
    expect(complete.mock.calls[1]![0].user).toContain("<problems>");
    expect(complete.mock.calls[1]![0].user).toContain("not on that item's own candidate list");
  });

  it("rejects after the second failure, with the reasons, and never calls a third time", async () => {
    const { llm, complete } = fakeLlm([bad, bad, JSON.stringify(good)]);
    const r = await reviewBankRun({ llm }, input);
    expect(r).toMatchObject({
      ok: false,
      refused: false,
      errors: ["Suggestion 1: the candidate is not on that item's own candidate list."],
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(r.calls.map((c) => c.status)).toEqual(["needs_review", "needs_review"]);
  });

  it("stops at a refusal", async () => {
    const { llm, complete } = fakeLlm([{ text: "", refused: true }]);
    const r = await reviewBankRun({ llm }, input);
    expect(r).toMatchObject({ ok: false, refused: true });
    expect(r.calls.map((c) => c.status)).toEqual(["refused"]);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("the quality line", () => {
  it("counts accepted and rejected across reviews, pending in the latest, and earlier undecided ones apart", () => {
    expect(
      suggestionQuality(
        [
          { reviewId: "r1", decision: "accepted" },
          { reviewId: "r1", decision: "pending" },
          { reviewId: "r2", decision: "rejected" },
          { reviewId: "r2", decision: "pending" },
          { reviewId: "r2", decision: "pending" },
        ],
        "r2",
      ),
    ).toEqual({ accepted: 1, rejected: 1, pending: 2, superseded: 1 });
  });
});
