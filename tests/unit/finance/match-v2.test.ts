import { describe, expect, it } from "vitest";

import { buildInsurerItems, isOpen, matchV2 } from "@/lib/finance/match-v2";
import type { InsurerItem } from "@/lib/finance/match-v2";
import type { MatchInput, MatchSettings, OpenLine } from "@/lib/finance/match-v2-types";

const settings: MatchSettings = { toleranceAmount: 0.5, tolerancePct: 0, windowDays: 14, refMinLength: 4, setMaxItems: 4, itemLookBackDays: 60 };
const base = { allocated: new Map<string, number>(), closed: new Set<string>(), v1MatchedBatchIds: new Set<string>(), today: "2026-10-17", settings };
const receipt = (ref: string, amount: number, date = "2026-09-01", payer: string | null = "PAYER-A") => ({
  refKey: ref.replace(/[^A-Z0-9]/g, ""),
  paymentRef: ref,
  payerKey: payer,
  amount,
  date,
});
const line = (id: string, open: number, text: string, valueDate = "2026-09-10"): OpenLine => ({ id, valueDate, amount: open, allocated: 0, open, text });

describe("buildInsurerItems", () => {
  it("builds a receipt item with open amount and status", () => {
    const [i] = buildInsurerItems({ ...base, receipts: [receipt("RA-0001", 120)], batches: [], allocated: new Map([["ins|RA0001", 20]]) });
    expect(i).toMatchObject({ ref: "ins|RA0001", total: 120, allocated: 20, open: 100, status: "part", source: "receipt", refKeys: ["RA0001"] });
  });
  it("merges a receipt with batches of the same key and flags a mismatch", () => {
    const [i] = buildInsurerItems({
      ...base,
      receipts: [receipt("RA-0002", 100)],
      batches: [
        { id: "b1", refKey: "RA0002", payerKey: "x", date: "2026-08-20", sumPaid: 40 },
        { id: "b2", refKey: "RA0002", payerKey: null, date: "2026-08-25", sumPaid: 40 },
      ],
    });
    expect(i).toMatchObject({ source: "both", total: 100, receiptAmount: 100, batchSum: 80, mismatch: true, date: "2026-09-01", payerKey: "PAYER-A" });
  });
  it("does not flag a mismatch inside the tolerance", () => {
    const [i] = buildInsurerItems({ ...base, receipts: [receipt("RA-0003", 100)], batches: [{ id: "b1", refKey: "RA0003", payerKey: null, date: "2026-09-02", sumPaid: 99.6 }] });
    expect(i.mismatch).toBe(false);
  });
  it("makes one item per batch without a reference, with the earliest date and a normalised payer", () => {
    const items = buildInsurerItems({
      ...base,
      receipts: [],
      batches: [
        { id: "b9", refKey: null, payerKey: " payer-b ", date: "2026-09-03", sumPaid: 10 },
        { id: "b8", refKey: null, payerKey: null, date: "2026-09-01", sumPaid: 20 },
        { id: "b7", refKey: "XY99", payerKey: null, date: "2026-09-05", sumPaid: 5 },
        { id: "b6", refKey: "XY99", payerKey: "P", date: "2026-09-04", sumPaid: 5 },
      ],
    });
    expect(items.map((i) => i.ref)).toEqual(["ins|batch:b8", "ins|batch:b9", "ins|XY99"]);
    expect(items[1]).toMatchObject({ payerKey: "PAYER-B", refKeys: [], source: "remittance" });
    expect(items[2]).toMatchObject({ total: 10, date: "2026-09-04", payerKey: "P" });
  });
  it("treats a batch matched by the monthly run as fully allocated, and closed beats everything", () => {
    const items = buildInsurerItems({
      ...base,
      receipts: [receipt("RA-0004", 50), receipt("RA-0005", 50)],
      batches: [{ id: "b1", refKey: "RA0004", payerKey: null, date: "2026-09-02", sumPaid: 50 }],
      v1MatchedBatchIds: new Set(["b1"]),
      closed: new Set(["ins|RA0005"]),
    });
    expect(items[0]).toMatchObject({ ref: "ins|RA0004", matchedByMonthlyRun: true, status: "paid", open: 0 });
    expect(items[1]).toMatchObject({ ref: "ins|RA0005", status: "closed" });
    expect(items.filter(isOpen)).toHaveLength(0);
  });
  it("marks fully allocated as paid, over-allocation floors at zero, and skips non-positive totals", () => {
    const items = buildInsurerItems({
      ...base,
      receipts: [receipt("RA-0006", 50), receipt("RA-0007", 0)],
      batches: [],
      allocated: new Map([["ins|RA0006", 60]]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "paid", open: 0 });
  });
});

function items(...r: ReturnType<typeof receipt>[]): InsurerItem[] {
  return buildInsurerItems({ ...base, receipts: r, batches: [] });
}
const input = (over: Partial<MatchInput>): MatchInput => ({
  lines: [],
  items: [],
  aliases: [],
  rejected: new Set(),
  autoRules: new Set(["reference", "payer_sum"]),
  settings,
  ...over,
});

describe("matchV2 reference rule", () => {
  it("is exact and automatic", () => {
    const [s] = matchV2(input({ items: items(receipt("RA-0001", 100)), lines: [line("L1", 100, "RA-0001")] }));
    expect(s).toMatchObject({ rule: "reference", auto: true });
    expect(s.options[0].score).toBe(100);
    expect(s.options[0].reasons[0]).toBe("Payment reference RA-0001 found on the bank line");
  });
  it("accepts a difference inside the tolerance (score 95) and gives the item no more than the line has", () => {
    const [s] = matchV2(input({ items: items(receipt("RA-0001", 100)), lines: [line("L1", 99.7, "RA-0001")] }));
    expect(s.options[0].score).toBe(95);
    expect(s.options[0].allocations[0].amount).toBe(99.7);
    expect(s.auto).toBe(true);
  });
  it("explains a partial payment in plain English", () => {
    const [s] = matchV2(input({ items: items(receipt("RA-0001", 120)), lines: [line("L1", 20, "RA-0001")] }));
    expect(s.options[0].reasons).toContain("Bank paid 20.00 less than the 120.00 open: partial payment, 100.00 stays open on the item");
    expect(s.options[0].score).toBe(80);
    expect(s.auto).toBe(false);
  });
  it("spreads a partial payment over several items in date order", () => {
    const [s] = matchV2(
      input({ items: items(receipt("RA-0002", 50, "2026-09-02"), receipt("RA-0001", 50, "2026-09-01")), lines: [line("L1", 70, "RA-0001 RA-0002")] }),
    );
    expect(s.options[0].allocations.map((a) => [a.itemRef, a.amount])).toEqual([["ins|RA0001", 50], ["ins|RA0002", 20]]);
  });
  it("is ambiguous when one key belongs to two items", () => {
    const a = items(receipt("RA-0001", 50))[0];
    const b = { ...a, ref: "ins|other", label: "RA-0001 b" };
    const out = matchV2(input({ items: [a, b], lines: [line("L1", 50, "RA-0001")] }));
    expect(out[0].options).toHaveLength(2);
    expect(out[0].auto).toBe(false);
  });
  it("does not match a key inside a longer number", () => {
    expect(matchV2(input({ items: items(receipt("12345", 100, "2026-01-01", null)), lines: [line("L1", 999, "REF 912345")] }))).toEqual([]);
  });
});

describe("matchV2 payer_sum and amount_date", () => {
  it("never uses a payer when two different payers are named", () => {
    const out = matchV2(
      input({ items: items(receipt("RA-0001", 50), receipt("RB-0001", 50, "2026-09-01", "PAYER-B")), lines: [line("L1", 50, "PAYER-A PAYER-B")] }),
    );
    expect(out[0].rule).toBe("amount_date");
  });
  it("respects the look-back and the window", () => {
    const its = items(receipt("RA-0001", 50, "2026-06-01"));
    expect(matchV2(input({ items: its, lines: [line("L1", 50, "PAYER-A")] }))).toEqual([]);
    const later = items(receipt("RA-0001", 50, "2026-09-30"));
    expect(matchV2(input({ items: later, lines: [line("L1", 50, "PAYER-A")] }))).toEqual([]);
    const ok = items(receipt("RA-0001", 50, "2026-09-24"));
    expect(matchV2(input({ items: ok, lines: [line("L1", 50, "PAYER-A")] }))[0].rule).toBe("payer_sum");
  });
  it("gives a unique single item 90, a unique set 85 and an ambiguous result 60", () => {
    const single = matchV2(input({ items: items(receipt("RA-0001", 50)), lines: [line("L1", 50, "PAYER-A")] }));
    expect(single[0].options[0].score).toBe(90);
    const set = matchV2(input({ items: items(receipt("RA-0001", 30), receipt("RA-0002", 20)), lines: [line("L1", 50, "PAYER-A")] }));
    expect(set[0].options[0].score).toBe(85);
    const amb = matchV2(input({ items: items(receipt("RA-0001", 50), receipt("RA-0002", 50)), lines: [line("L1", 50, "PAYER-A")] }));
    expect(amb[0].options.map((o) => o.score)).toEqual([60, 60]);
  });
  it("proposes amount and date only, closest date first, at most five, never automatic", () => {
    const rs = Array.from({ length: 7 }, (_, i) => receipt(`RB-000${i + 1}`, 40, `2026-09-0${i + 1}`, `P${i}`));
    const [s] = matchV2(input({ items: items(...rs), lines: [line("L1", 40, "NO NAME")] }));
    expect(s.rule).toBe("amount_date");
    expect(s.options).toHaveLength(5);
    expect(s.options[0].allocations[0].itemRef).toBe("ins|RB0007");
    expect(s.auto).toBe(false);
  });
});

describe("matchV2 properties", () => {
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const shuffle = <T,>(a: readonly T[], r: () => number) => {
    const o = [...a];
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  };
  const its = items(
    receipt("RA-0001", 120.25),
    receipt("RA-0002", 80, "2026-09-03"),
    receipt("RA-0003", 40, "2026-09-04"),
    receipt("RA-0004", 40, "2026-09-05"),
    receipt("RA-0005", 80, "2026-09-05"),
    receipt("RB-0001", 40, "2026-09-02", "PAYER-B"),
  );
  const lines = [
    line("L1", 20, "RA-0001"),
    line("L2", 120, "PAYER-A"),
    line("L3", 40, "UNKNOWN", "2026-09-06"),
    line("L4", 200, "RA-0002 RA-0003"),
    line("L5", 80, "PAYER-A", "2026-09-07"),
    line("L6", 10, "RA-0001", "2026-09-08"),
  ];
  const run = (l: readonly OpenLine[], i: readonly InsurerItem[]) => matchV2(input({ lines: l, items: i }));
  const baseline = run(lines, its);

  it("never over-allocates a line or an item, and never allocates zero or less", () => {
    expect(baseline.length).toBeGreaterThan(3);
    for (const s of baseline) {
      const l = lines.find((x) => x.id === s.lineId)!;
      for (const o of s.options) {
        expect(o.allocations.length).toBeGreaterThan(0);
        let sum = 0;
        for (const a of o.allocations) {
          const it = its.find((x) => x.ref === a.itemRef)!;
          expect(a.amount).toBeGreaterThan(0);
          expect(a.amount).toBeLessThanOrEqual(it.open + 1e-9);
          sum += a.amount;
        }
        expect(sum).toBeLessThanOrEqual(l.open + 1e-9);
      }
    }
  });
  it("is deterministic under shuffled input", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = rng(seed);
      expect(run(shuffle(lines, r), shuffle(its, r))).toEqual(baseline);
    }
  });
  it("does not change its input", () => {
    const before = JSON.stringify({ lines, its });
    run(lines, its);
    expect(JSON.stringify({ lines, its })).toBe(before);
  });
});

describe("payer_sum search bounds (review fixes)", () => {
  const payerItems = (n: number): InsurerItem[] =>
    buildInsurerItems({
      ...base,
      receipts: Array.from({ length: n }, (_, i) => receipt(`RA-${String(1000 + i)}`, 100 + i * 7, "2026-09-05")),
      batches: [],
    });
  const input = (items: InsurerItem[], amount: number, extra: Partial<MatchInput> = {}): MatchInput => ({
    lines: [line("L1", amount, "PAYER-A TRANSFER")],
    items,
    aliases: [],
    rejected: new Set(),
    autoRules: new Set(["payer_sum"]),
    settings: { ...settings, setMaxItems: 8 },
    ...extra,
  });

  it("answers fast when 30 items are open and no set reaches the amount", () => {
    const t = Date.now();
    const out = matchV2(input(payerItems(30), 99_999.13));
    expect(out.filter((s) => s.rule === "payer_sum")).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1500);
  });
  it("never auto-matches when the payer has more open items than were searched", () => {
    const items = payerItems(35);
    const target = items[0].open; // exactly one item has this amount; the rest of the search space was truncated
    const sug = matchV2(input(items, target)).find((s) => s.rule === "payer_sum");
    expect(sug).toBeDefined();
    expect(sug!.auto).toBe(false);
  });
  it("still auto-matches a unique set when everything was searched", () => {
    const items = payerItems(5);
    const sug = matchV2(input(items, items[2].open)).find((s) => s.rule === "payer_sum");
    expect(sug?.options).toHaveLength(1);
    expect(sug?.auto).toBe(true);
  });
});
