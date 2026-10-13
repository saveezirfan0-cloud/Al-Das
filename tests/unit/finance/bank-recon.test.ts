/**
 * Phase 20C: the pure bank reconciliation rules on a synthetic October (cut-off 30th, weekend Saturday and Sunday):
 * working-day calendar, periods, expected receipts (lag, fee, refunds, settlement reports, insurance), scoring, the
 * "only candidate on both sides" rule for automatic matches, ties never guessed, ageing and the review blockers.
 */
import { describe, expect, it } from "vitest";

import {
  addWorkingDays,
  ageBucket,
  bankItemKey,
  buildExpected,
  periodFor,
  reconcileRun,
  runFigures,
  scoreCandidate,
  toleranceCents,
  type BankLine,
  type BankSettings,
  type Decision,
  type ExpectedItem,
  type Note,
  type RunInput,
  type SettlementRule,
} from "@/lib/finance/bank-recon";

import fx from "./fixtures/bank.synthetic.json";

const settings: BankSettings = fx.settings;
const ACC = fx.accounts as Record<"OPS" | "INS", string>;
const rules: SettlementRule[] = fx.rules.map((r) => ({
  mode: r.mode,
  lagDays: r.lagDays,
  feePct: r.feePct,
  accountId: r.account ? ACC[r.account as "OPS" | "INS"] : null,
  settlesToBank: r.settlesToBank,
  source: r.source as "collections" | "settlement",
}));
const L = (n: number) => `00000000-0000-4000-8000-000000000${n}`;

function input(account: "OPS" | "INS", extra: Partial<RunInput> = {}): RunInput {
  return {
    accountId: ACC[account],
    receivesInsurance: account === "INS",
    period: fx.period,
    rules,
    settings,
    collections: fx.collections,
    settlements: fx.settlements,
    remittances: fx.remittances,
    lines: fx.lines[account] as BankLine[],
    matchedElsewhere: new Set(fx.matchedElsewhere),
    decisions: [],
    notes: [],
    today: fx.today,
    statementEnd: fx.statementEnd,
    ...extra,
  };
}

describe("working-day calendar and periods", () => {
  const SAT_SUN = [0, 6];
  it("adds working days, skipping the weekend", () => {
    expect(addWorkingDays("2026-10-01", 2, SAT_SUN)).toBe("2026-10-05"); // Thu + 2 = Mon (T+2 card)
    expect(addWorkingDays("2026-10-02", 2, SAT_SUN)).toBe("2026-10-06"); // Fri + 2 = Tue
    expect(addWorkingDays("2026-10-03", 1, SAT_SUN)).toBe("2026-10-05"); // Sat + 1 = Mon
    expect(addWorkingDays("2026-10-09", 6, SAT_SUN)).toBe("2026-10-19"); // Fri + 6 = Mon week after (Tabby T+6)
    expect(addWorkingDays("2026-10-04", 0, SAT_SUN)).toBe("2026-10-04"); // lag 0 = same day
  });

  it("uses the configured weekend (Friday and Saturday)", () => {
    expect(addWorkingDays("2026-10-01", 1, [5, 6])).toBe("2026-10-04"); // Thu + 1 = Sun
    expect(addWorkingDays("2026-10-01", 1, [])).toBe("2026-10-02");
    expect(() => addWorkingDays("2026-10-01", 1, [0, 1, 2, 3, 4, 5, 6])).toThrow();
  });

  it("cuts months on the cut-off day (or the month's last day when shorter)", () => {
    expect(periodFor("2026-10-01", 30)).toEqual({ start: "2026-10-01", end: "2026-10-30" });
    expect(periodFor("2026-11-01", 30)).toEqual({ start: "2026-10-31", end: "2026-11-30" });
    expect(periodFor("2027-01-01", 30)).toEqual({ start: "2026-12-31", end: "2027-01-30" });
    expect(periodFor("2027-02-01", 30)).toEqual({ start: "2027-01-31", end: "2027-02-28" });
    expect(periodFor("2027-03-01", 30)).toEqual({ start: "2027-03-01", end: "2027-03-30" });
    expect(periodFor("2026-10-01", 31)).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(periodFor("2028-02-01", 31)).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("ages from the expected date and waits inside the date window", () => {
    expect(ageBucket(null, 3)).toBe("waiting");
    expect(ageBucket(-5, 3)).toBe("waiting");
    expect(ageBucket(3, 3)).toBe("waiting");
    expect(ageBucket(4, 3)).toBe("0-7");
    expect(ageBucket(7, 3)).toBe("0-7");
    expect(ageBucket(8, 3)).toBe("8-30");
    expect(ageBucket(30, 3)).toBe("8-30");
    expect(ageBucket(31, 3)).toBe("31-60");
    expect(ageBucket(60, 3)).toBe("31-60");
    expect(ageBucket(61, 3)).toBe("60+");
  });
});

describe("expected receipts", () => {
  const { items, notReconciled } = buildExpected(input("OPS"));
  const by = (key: string) => items.find((i) => i.key === key)!;

  it("groups Unite collections by mode and paid date, subtracts refunds and the expected fee", () => {
    expect(by("col|Card|2026-10-01")).toMatchObject({
      kind: "collection",
      gross: 1000,
      fee: 25,
      amount: 975,
      expectedDate: "2026-10-05",
    });
    expect(by("col|Card|2026-10-02")).toMatchObject({
      gross: 1900,
      fee: 47.5,
      amount: 1852.5,
      expectedDate: "2026-10-06",
    });
    expect(by("col|EPG|2026-10-05")).toMatchObject({ amount: 490, expectedDate: "2026-10-07" });
    expect(by("col|Cash|2026-10-06")).toMatchObject({
      amount: 300,
      fee: 0,
      expectedDate: "2026-10-07",
    });
  });

  it("uses the processor's payouts for a settlement-report mode and flags Unite vs processor differences", () => {
    expect(items.filter((i) => i.mode === "Tabby" && i.kind === "collection")).toEqual([]);
    expect(by("pay|Tabby|2026-10-16/TBY-7781")).toMatchObject({
      kind: "payout",
      gross: 950,
      fee: 47.5,
      amount: 902.5,
      expectedDate: "2026-10-16",
      references: ["TBY-7781"],
    });
    // 8 Oct: Unite 600 = processor 600 (no item); 9 Oct: Unite 400, processor 350
    expect(
      items.filter((i) => i.kind === "gap").map((i) => [i.key, i.amount, i.expectedDate]),
    ).toEqual([["gap|Tabby|2026-10-09", 50, "2026-10-19"]]);
  });

  it("lists modes that cannot be reconciled yet, and leaves insurance credit to the remittance matching", () => {
    expect(notReconciled).toEqual([
      { mode: "rePG", gross: 400, days: 1, why: "No bank account chosen" },
    ]);
    expect(items.some((i) => i.mode === "Insurance credit")).toBe(false);
  });

  it("expects insurance remittances only in the account that receives them", () => {
    expect(items.some((i) => i.kind === "insurance")).toBe(false);
    const ins = buildExpected(input("INS")).items;
    expect(ins).toEqual([
      expect.objectContaining({
        key: `ins|${fx.remittances[0].id}`,
        kind: "insurance",
        amount: 12000,
        references: ["RA-55501"],
      }),
    ]);
  });

  it("puts a mode's collections only in the account of its rule", () => {
    expect(buildExpected(input("INS")).items.some((i) => i.kind === "collection")).toBe(false);
  });

  it("skips a day of net refunds and collections outside the period", () => {
    const r = buildExpected(
      input("OPS", {
        collections: [
          { mode: "Card", date: "2026-10-12", paid: 100, refunds: 300, payments: 1 },
          { mode: "Card", date: "2026-10-31", paid: 900, refunds: 0, payments: 1 },
        ],
        settlements: [],
      }),
    );
    expect(r.items.filter((i) => i.kind === "collection")).toEqual([]);
  });

  it("treats the payment mode case-insensitively", () => {
    const r = buildExpected(
      input("OPS", {
        collections: [{ mode: "CARD ", date: "2026-10-12", paid: 100, refunds: 0, payments: 1 }],
        settlements: [],
      }),
    );
    expect(r.items.map((i) => i.key)).toEqual(["col|Card|2026-10-12"]);
  });

  it("needs a lag, a fee % and an account before a mode counts as configured", () => {
    const partial = rules.map((r) => (r.mode === "Card" ? { ...r, feePct: null } : r));
    const r = buildExpected(input("OPS", { rules: partial }));
    expect(r.notReconciled.find((n) => n.mode === "Card")).toMatchObject({ gross: 2900, days: 2 });
    expect(r.notReconciled.find((n) => n.mode === "Card")!.why).toMatch(/Fee %/);
  });
});

describe("scoring", () => {
  const item: ExpectedItem = {
    key: "col|Card|2026-10-01",
    kind: "collection",
    mode: "Card",
    sourceDate: "2026-10-01",
    expectedDate: "2026-10-05",
    gross: 1000,
    fee: 25,
    amount: 975,
    references: [],
  };
  const line = (o: Partial<BankLine>): BankLine => ({
    id: "l",
    valueDate: "2026-10-05",
    amount: 975,
    reference: null,
    description: null,
    ...o,
  });

  it("gives up to 50 for the amount, 30 for the date, 10 for a reference and 10 for naming the mode", () => {
    expect(scoreCandidate(item, line({}), settings)!.score).toBe(80);
    expect(scoreCandidate(item, line({ description: "CARD SETTLEMENT" }), settings)!.score).toBe(
      90,
    );
    const withRef = { ...item, references: ["TBY-7781"] };
    expect(
      scoreCandidate(withRef, line({ reference: "tby 7781", description: "card" }), settings),
    ).toMatchObject({
      score: 100,
      reasons: [
        "Amount exact",
        "On the expected date",
        "Reference found on the bank line",
        "Bank line mentions Card",
      ],
    });
  });

  it("lowers the score with the amount difference and the days, and drops lines outside either", () => {
    expect(scoreCandidate(item, line({ amount: 974.5 }), settings)!.score).toBe(37 + 30);
    expect(scoreCandidate(item, line({ valueDate: "2026-10-06" }), settings)!.score).toBe(50 + 23);
    expect(scoreCandidate(item, line({ valueDate: "2026-10-08" }), settings)!.score).toBe(50 + 8);
    expect(scoreCandidate(item, line({ valueDate: "2026-10-09" }), settings)).toBeNull(); // 4 days > window 3
    expect(scoreCandidate(item, line({ amount: 973.99 }), settings)).toBeNull(); // 1.01 > tolerance 1.00
    expect(scoreCandidate(item, line({ amount: -975 }), settings)).toBeNull(); // debits never match
  });

  it("uses the larger of the fixed and the percentage tolerance", () => {
    expect(toleranceCents(10000, { ...settings, tolerancePct: 0.5 })).toBe(5000);
    expect(toleranceCents(10, { ...settings, tolerancePct: 0.5 })).toBe(100);
    const big = { ...item, amount: 10000 };
    expect(
      scoreCandidate(big, line({ amount: 9960 }), { ...settings, tolerancePct: 0.5 }),
    ).not.toBeNull();
    expect(scoreCandidate(big, line({ amount: 9960 }), settings)).toBeNull();
  });

  it("never scores a Unite vs processor difference against the bank", () => {
    expect(scoreCandidate({ ...item, kind: "gap", amount: 975 }, line({}), settings)).toBeNull();
  });
});

describe("a run", () => {
  const r = reconcileRun(input("OPS"));
  const card1 = "col|Card|2026-10-01";
  const card2 = "col|Card|2026-10-02";
  const epg = "col|EPG|2026-10-05";
  const payout = "pay|Tabby|2026-10-16/TBY-7781";

  it("matches automatically only a sole candidate on both sides above the threshold", () => {
    expect(r.autoReady.map((a) => [a.item.key, a.candidate.lineId, a.candidate.score])).toEqual([
      [card1, L(101), 90],
      [payout, L(105), 100],
    ]);
  });

  it("proposes a single candidate below the threshold, and never picks between two that fit", () => {
    expect(
      r.proposals.map((p) => [
        p.item.key,
        p.candidates.map((c) => [c.lineId, c.score, c.ambiguous]),
      ]),
    ).toEqual([
      [card2, [[L(102), 67, false]]],
      [
        epg,
        [
          [L(103), 90, true],
          [L(104), 83, true],
        ],
      ],
    ]);
  });

  it("ages what did not arrive and lists the bank credits nothing explains", () => {
    expect(r.asOf).toBe("2026-10-31");
    expect(r.unmatched.map((u) => [u.item.key, u.bucket, u.daysPast, u.needsReason])).toEqual([
      ["col|Cash|2026-10-06", "8-30", 24, true],
      ["gap|Tabby|2026-10-09", "8-30", 15, true],
    ]);
    // the 29 Sep line was matched by September's run; the 31 Oct line is November's; the rent is a debit
    expect(r.bankUnmatched.map((b) => b.line.id)).toEqual([L(106)]);
    expect(r.summary.bankDebits).toEqual({ count: 1, amount: 500 });
    expect(r.summary).toMatchObject({
      expectedCount: 5,
      expectedAmount: 4520,
      autoReady: 2,
      proposed: 2,
    });
    expect(r.summary.gaps).toEqual({ count: 1, amount: 50 });
  });

  it("blocks the review until everything is decided and explained", () => {
    expect(r.problems).toEqual([
      "Run matching to save 2 automatic match(es).",
      "Accept or reject 2 proposed match(es).",
      "Give a reason for 2 item(s) past their expected date.",
      "Explain 1 unmatched bank credit(s).",
    ]);
  });

  const decided = (decisions: Decision[], notes: Note[] = []) =>
    reconcileRun(input("OPS", { decisions, notes }));
  const m = (
    expectedKey: string,
    n: number,
    status: Decision["status"] = "matched",
    auto = false,
  ): Decision => ({
    expectedKey,
    lineId: L(n),
    status,
    auto,
    score: 0,
  });

  it("a rejection removes that pairing; a candidate left alone becomes automatic", () => {
    const after = decided([m(epg, 103, "rejected")]);
    expect(after.autoReady.map((a) => [a.item.key, a.candidate.lineId])).toContainEqual([
      epg,
      L(104),
    ]);
    expect(after.proposals.map((p) => p.item.key)).toEqual([card2]);
    // and the rejected line is now a bank credit nothing explains
    expect(after.bankUnmatched.map((b) => b.line.id)).toEqual([L(103), L(106)]);
  });

  it("is clean once every pair is decided and every open item has a reason", () => {
    const decisions = [
      m(card1, 101, "matched", true),
      m(payout, 105, "matched", true),
      m(card2, 102),
      m(epg, 103),
    ];
    const notes: Note[] = [
      { itemKey: "col|Cash|2026-10-06", code: "bank_query", note: null },
      { itemKey: "gap|Tabby|2026-10-09", code: "fee_difference", note: null },
      { itemKey: bankItemKey(L(106)), code: "internal_transfer", note: null },
      { itemKey: bankItemKey(L(104)), code: "other_income", note: null },
    ];
    const done = decided(decisions, notes);
    expect(done.problems).toEqual([]);
    expect(done.summary).toMatchObject({
      matchedCount: 4,
      matchedExpected: 4220,
      matchedBank: 4219.5,
      matchedDifference: -0.5,
    });
    const figures = runFigures(done, { accountId: ACC.OPS, period: fx.period });
    expect(figures.problems).toEqual([]);
    expect(JSON.stringify(figures)).not.toMatch(/SETTLEMENT|PAYOUT|TRANSFER/); // ids, codes, dates and amounts only
  });

  it("flags a match whose expected item vanished or whose amount moved", () => {
    const orphan = decided([m("col|Card|2026-10-29", 101)]);
    expect(orphan.problems[0]).toMatch(/no longer exists/);
    const moved = reconcileRun(
      input("OPS", {
        decisions: [m(card1, 101)],
        collections: fx.collections.map((c) =>
          c.mode === "Card" && c.date === "2026-10-01" ? { ...c, paid: 1100 } : c,
        ),
      }),
    );
    expect(moved.matched.find((x) => x.expectedKey === card1)!.changed).toBe(true);
    expect(moved.problems.some((p) => /changed since/.test(p))).toBe(true);
  });

  it("waits for the statement: nothing is aged before it is imported, and the review needs the whole period", () => {
    const none = reconcileRun(input("OPS", { statementEnd: null }));
    expect(none.asOf).toBeNull();
    expect(
      none.unmatched.filter((u) => u.item.kind !== "gap").every((u) => u.bucket === "waiting"),
    ).toBe(true);
    expect(none.problems[0]).toMatch(/Import a statement/);
    const short = reconcileRun(input("OPS", { statementEnd: "2026-10-20" }));
    expect(short.problems[0]).toMatch(/end on 2026-10-20, before the period ends/);
  });

  it("matches an insurer's bulk payment to its remittance batch, using the reference", () => {
    const ins = reconcileRun(input("INS"));
    expect(ins.autoReady.map((a) => [a.item.key, a.candidate.lineId, a.candidate.score])).toEqual([
      [`ins|${fx.remittances[0].id}`, L(201), 83],
    ]);
    expect(ins.autoReady[0].candidate.reasons).toContain("Reference found on the bank line");
  });

  it("is deterministic: the same input gives the same result whatever the order of the lines", () => {
    const shuffled = reconcileRun(
      input("OPS", { lines: [...(fx.lines.OPS as BankLine[])].reverse() }),
    );
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(r));
  });
});
