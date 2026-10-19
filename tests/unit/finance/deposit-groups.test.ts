/**
 * W3 follow-up 1 (docs/48): one bank deposit = several insurer payment references, in the monthly bank run.
 * - splitting a remittance file into one item per payment reference (fails closed);
 * - the group search wired into reconcileRun: groups are proposals only (never automatic), ties and shared payments are
 *   "Several fit", rejected groups are not offered again, an accepted group covers its members, orphans and double
 *   matches are problems, and without the hook the run is unchanged.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  depositGroupKey,
  depositGroupMembers,
  groupExpectedItem,
  reconcileRun,
  type BankLine,
  type Decision,
  type RemittanceBatch,
  type RunInput,
} from "@/lib/finance/bank-recon";
import {
  depositGroupSearch,
  refPartSuffix,
  splitRemittanceByReference,
  type RemittanceRefPart,
} from "@/lib/finance/deposit-groups";
import type { DepositSettings } from "@/lib/finance/deposit-match";

const S: DepositSettings = {
  weekendDays: [0, 6],
  windowDays: 3,
  toleranceAmount: 1,
  tolerancePct: 0,
  autoAcceptScore: 80,
  cutoffDay: 30,
  maxParts: 5,
  maxPool: 40,
};
const ACC = "00000000-0000-4000-8000-0000000000aa";
const L = (n: number) => `00000000-0000-4000-8000-00000000010${n}`;
const B = (n: number) => `00000000-0000-4000-8000-00000000020${n}`;

const batch = (n: number, amount: number, ref: string, payer = "PAYER-A", date = "2026-10-20") =>
  ({ id: B(n), ref, payerId: payer, date, amount }) satisfies RemittanceBatch;
const line = (n: number, amount: number, reference = "TRANSFER", valueDate = "2026-10-21") =>
  ({ id: L(n), valueDate, amount, reference, description: null }) satisfies BankLine;

function run(
  remittances: RemittanceBatch[],
  lines: BankLine[],
  extra: Partial<RunInput> = {},
  settings: DepositSettings = S,
) {
  return reconcileRun({
    accountId: ACC,
    receivesInsurance: true,
    period: { start: "2026-10-01", end: "2026-10-30" },
    rules: [],
    settings,
    collections: [],
    settlements: [],
    remittances,
    lines,
    matchedElsewhere: new Set(),
    decisions: [],
    notes: [],
    today: "2026-11-05",
    statementEnd: "2026-11-04",
    proposeGroups: depositGroupSearch(settings),
    ...extra,
  });
}
const keysOf = (r: ReturnType<typeof run>) => r.proposals.map((p) => p.item.key);
const g = (...batches: number[]) => depositGroupKey(batches.map((n) => `ins|${B(n)}`));

describe("group keys", () => {
  it("round-trip, sorted, and only for insurance members", () => {
    const k = depositGroupKey(["ins|b", "ins|a"]);
    expect(k).toBe("insg|ins|a+ins|b");
    expect(depositGroupMembers(k)).toEqual(["ins|a", "ins|b"]);
    expect(depositGroupMembers("ins|a")).toBeNull();
    expect(depositGroupMembers("insg|ins|a")).toBeNull(); // one member is not a group
    expect(depositGroupMembers("insg|col|x+ins|a")).toBeNull();
  });

  it("a group item is the members' total with the latest date and every reference", () => {
    const r = run([batch(1, 300, "RM-1", "PAYER-A", "2026-10-18"), batch(2, 200, "RM-2")], []);
    const item = groupExpectedItem(r.items);
    expect(item).toMatchObject({
      key: g(1, 2),
      kind: "insurance",
      mode: "PAYER-A",
      expectedDate: "2026-10-20",
      amount: 500,
      references: ["RM-1", "RM-2"],
    });
  });
});

describe("splitRemittanceByReference", () => {
  const part = (batchId: string, ref: string | null, amount: number, payer = "PAYER-A") =>
    ({
      batchId,
      ref,
      payerId: payer,
      paidOn: "2026-10-19",
      amount,
      lines: 3,
    }) satisfies RemittanceRefPart;

  it("keeps a file with one reference as one item under its old key", () => {
    const out = splitRemittanceByReference(
      [{ ...batch(1, 500, "RM-1"), ref: null }],
      [part(B(1), "RM-1", 500)],
    );
    expect(out).toEqual([{ ...batch(1, 500, "RM-1"), batchId: B(1) }]);
  });

  it("splits a file with several references into one item each, with a stable suffix", () => {
    const out = splitRemittanceByReference(
      [{ ...batch(1, 500, "RM-1"), ref: null }],
      [part(B(1), "RM-1", 300), part(B(1), "RM-2", 200)],
    );
    expect(out.map((o) => [o.id, o.ref, o.amount, o.date, o.batchId])).toEqual(
      [
        [`${B(1)}|${refPartSuffix("RM-1", "PAYER-A")}`, "RM-1", 300, "2026-10-19", B(1)],
        [`${B(1)}|${refPartSuffix("RM-2", "PAYER-A")}`, "RM-2", 200, "2026-10-19", B(1)],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    expect(refPartSuffix(" rm-1 ", "payer-a")).toBe(refPartSuffix("RM-1", "PAYER-A"));
    expect(refPartSuffix("RM-1", "PAYER-A")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("fails closed: parts that do not add up, or a take-back part, keep the file whole", () => {
    const whole = { ...batch(1, 500, "RM-1"), ref: null };
    expect(
      splitRemittanceByReference([whole], [part(B(1), "RM-1", 300), part(B(1), "RM-2", 150)]),
    ).toHaveLength(1);
    expect(
      splitRemittanceByReference(
        [{ ...whole, amount: 400 }],
        [part(B(1), "RM-1", 500), part(B(1), "RM-2", -100)],
      ),
    ).toHaveLength(1);
  });

  it("a file with no committed lines stays as it is", () => {
    expect(splitRemittanceByReference([batch(1, 500, "RM-1")], [])).toEqual([
      { ...batch(1, 500, "RM-1"), batchId: B(1) },
    ]);
  });
});

describe("deposit groups in the monthly run", () => {
  it("proposes the group a credit is the total of, never automatically", () => {
    const r = run([batch(1, 300, "RM-1"), batch(2, 200, "RM-2")], [line(1, 500)]);
    expect(r.autoReady).toEqual([]);
    expect(keysOf(r)).toEqual([g(1, 2)]);
    const [c] = r.proposals[0].candidates;
    expect(c).toMatchObject({ lineId: L(1), ambiguous: false, bankAmount: 500, amountDiff: 0 });
    expect(c.reasons[0]).toMatch(/^Total of 2 insurer payments/);
    expect(r.bankUnmatched).toEqual([]);
    expect(r.problems).toContain("Accept or reject 1 proposed match(es).");
  });

  it("is still only a proposal when the bank line names every reference", () => {
    const r = run(
      [batch(1, 300, "RM-0001"), batch(2, 200, "RM-0002")],
      [line(1, 500, "RM-0001 RM-0002")],
    );
    expect(r.autoReady).toEqual([]);
    expect(r.proposals[0].candidates[0].reasons[1]).toBe(
      "2 of 2 payment references found on the bank line",
    );
  });

  it("without the hook (or with maxParts 1) the run is unchanged: the credit needs a reason", () => {
    const rem = [batch(1, 300, "RM-1"), batch(2, 200, "RM-2")];
    const off = run(rem, [line(1, 500)], { proposeGroups: undefined });
    expect(off.proposals).toEqual([]);
    expect(off.bankUnmatched.map((b) => b.line.id)).toEqual([L(1)]);
    const one = run(rem, [line(1, 500)], {}, { ...S, maxParts: 1 });
    expect(one.proposals).toEqual([]);
  });

  it("marks every group 'Several fit' when two groups fit one credit (C09)", () => {
    const r = run(
      [batch(1, 300, "A"), batch(2, 200, "B"), batch(3, 125, "C"), batch(4, 225, "D")],
      [line(1, 425)],
    );
    expect(keysOf(r).sort()).toEqual([g(1, 3), g(2, 4)].sort());
    expect(r.proposals.every((p) => p.candidates.every((c) => c.ambiguous))).toBe(true);
    expect(r.autoReady).toEqual([]);
  });

  it("marks a group 'Several fit' when its payment is also offered to another credit", () => {
    const r = run(
      [batch(1, 300, "A"), batch(2, 200, "B"), batch(3, 200, "C")],
      [line(1, 500), line(2, 400)],
    );
    // 500 = 1+2 or 1+3; 400 = 2+3: every group shares a payment with another credit's group
    expect(r.proposals.length).toBeGreaterThan(1);
    expect(r.proposals.every((p) => p.candidates.every((c) => c.ambiguous))).toBe(true);
  });

  it("never groups payments of different payers", () => {
    const r = run([batch(1, 300, "A", "PAYER-A"), batch(2, 200, "B", "PAYER-B")], [line(1, 500)]);
    expect(r.proposals).toEqual([]);
    expect(r.bankUnmatched.map((b) => b.line.id)).toEqual([L(1)]);
  });

  it("only groups items and credits that found nothing on their own", () => {
    // payment 1 (300) has its own credit; the 500 credit could only be 1+2, so nothing is proposed for it
    const r = run([batch(1, 300, "A"), batch(2, 200, "B")], [line(1, 500), line(2, 300)]);
    expect(keysOf(r)).toEqual([`ins|${B(1)}`]); // its own single proposal, no group
    expect(r.bankUnmatched.map((b) => b.line.id)).toEqual([L(1)]);
  });

  it("does not offer a group again once a person rejected it for that credit", () => {
    const rejected: Decision = {
      expectedKey: g(1, 2),
      lineId: L(1),
      status: "rejected",
      auto: false,
      score: 70,
    };
    const r = run([batch(1, 300, "A"), batch(2, 200, "B")], [line(1, 500)], {
      decisions: [rejected],
    });
    expect(r.proposals).toEqual([]);
    expect(r.bankUnmatched.map((b) => b.line.id)).toEqual([L(1)]);
  });

  it("an accepted group covers its members: matched once, nothing left open", () => {
    const accepted: Decision = {
      expectedKey: g(1, 2),
      lineId: L(1),
      status: "matched",
      auto: false,
      score: 70,
    };
    const r = run([batch(1, 300, "A"), batch(2, 200, "B")], [line(1, 500)], {
      decisions: [accepted],
    });
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].item).toMatchObject({ key: g(1, 2), amount: 500 });
    expect(r.matched[0].changed).toBe(false);
    expect(r.unmatched).toEqual([]);
    expect(r.proposals).toEqual([]);
    expect(r.bankUnmatched).toEqual([]);
    expect(r.summary).toMatchObject({ matchedCount: 1, matchedExpected: 500, matchedBank: 500 });
    expect(r.problems.filter((p) => !p.startsWith("The statements"))).toEqual([]);
  });

  it("a saved group whose member disappeared is an orphan to undo", () => {
    const accepted: Decision = {
      expectedKey: g(1, 2),
      lineId: L(1),
      status: "matched",
      auto: false,
      score: 70,
    };
    const r = run([batch(1, 300, "A")], [line(1, 500)], { decisions: [accepted] });
    expect(r.matched[0].item).toBeNull();
    expect(r.problems).toContain(
      "Undo 1 match(es) whose expected item or bank line no longer exists.",
    );
  });

  it("an item matched on its own and inside a group is a problem", () => {
    const decisions: Decision[] = [
      { expectedKey: g(1, 2), lineId: L(1), status: "matched", auto: false, score: 70 },
      { expectedKey: `ins|${B(1)}`, lineId: L(2), status: "matched", auto: false, score: 90 },
    ];
    const r = run([batch(1, 300, "A"), batch(2, 200, "B")], [line(1, 500), line(2, 300)], {
      decisions,
    });
    expect(r.problems).toContain(
      "Undo a match for 1 item(s) matched twice (on their own and in a group of payments).",
    );
  });

  it("reports credits whose payer had too many payments in range to search groups", () => {
    const many = Array.from({ length: 5 }, (_, i) => batch(i + 1, 100 + i, `R${i}`));
    const r = run(many, [line(1, 999)], {}, { ...S, maxPool: 4 });
    expect(r.groupSearchSkipped).toEqual([L(1)]);
    expect(r.bankUnmatched.map((b) => b.line.id)).toEqual([L(1)]);
  });

  it("is deterministic", () => {
    const rem = [batch(1, 300, "A"), batch(2, 200, "B"), batch(3, 125, "C"), batch(4, 225, "D")];
    const a = run(rem, [line(1, 425), line(2, 500)]);
    const b = run([...rem].reverse(), [line(2, 500), line(1, 425)]);
    expect(a.proposals).toEqual(b.proposals);
  });
});
