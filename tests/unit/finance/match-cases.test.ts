/** The scenario catalogue (match-cases.synthetic.json): each case builds items, runs the engine and checks the answer. */
import { describe, expect, it } from "vitest";

import { refKey } from "@/lib/finance/match-keys";
import { buildInsurerItems, isOpen, matchV2 } from "@/lib/finance/match-v2";
import type { AutoRule, MatchSettings } from "@/lib/finance/match-v2-types";

import catalogue from "./match-cases.synthetic.json";

type Case = (typeof catalogue.cases)[number] & Record<string, unknown>;
type Expected = {
  lineId: string;
  rule: string;
  options: number;
  auto: boolean;
  allocs?: Array<[string, number]>;
  itemsLeft?: number;
  lineLeft?: number;
  aliasId?: string;
};

const settings = catalogue.settings as MatchSettings;

function run(c: Case) {
  const items = buildInsurerItems({
    receipts: ((c.receipts as Array<Record<string, string | number>>) ?? []).map((r) => ({
      refKey: refKey(r.paymentRef as string)!,
      paymentRef: r.paymentRef as string,
      payerKey: r.payerKey as string,
      amount: r.amount as number,
      date: r.date as string,
    })),
    batches: ((c.batches as Array<Record<string, string | number>>) ?? []).map((b) => ({
      id: b.id as string,
      refKey: b.refKey as string,
      payerKey: b.payerKey as string,
      date: b.date as string,
      sumPaid: b.sumPaid as number,
    })),
    allocated: new Map(Object.entries((c.allocated as Record<string, number>) ?? {})),
    closed: new Set((c.closed as string[]) ?? []),
    v1MatchedBatchIds: new Set<string>(),
    today: "2026-10-17",
    settings,
  });
  return matchV2({
    lines: ((c.lines as Array<{ id: string; valueDate: string; open: number; text: string }>) ?? []).map((l) => ({
      ...l,
      amount: l.open,
      allocated: 0,
    })),
    items: items.filter(isOpen),
    aliases: (c.aliases as Array<{ id: string; payerKey: string; alias: string }>) ?? [],
    rejected: new Set((c.rejected as string[]) ?? []),
    autoRules: new Set((c.autoRules as AutoRule[]) ?? []),
    settings,
  });
}

describe("matching scenario catalogue", () => {
  for (const c of catalogue.cases as Case[]) {
    it(c.name, () => {
      const got = run(c);
      const want = c.expect as Expected[];
      expect(got.map((g) => g.lineId)).toEqual(want.map((w) => w.lineId));
      want.forEach((w, i) => {
        const g = got[i];
        expect(g.rule).toBe(w.rule);
        expect(g.options).toHaveLength(w.options);
        expect(g.auto).toBe(w.auto);
        const first = g.options[0];
        if (w.allocs) expect(first.allocations.map((a) => [a.itemRef, a.amount])).toEqual(w.allocs);
        if (w.itemsLeft !== undefined) expect(first.itemsLeft).toBe(w.itemsLeft);
        if (w.lineLeft !== undefined) expect(first.lineLeft).toBe(w.lineLeft);
        if (w.aliasId) expect(first.aliasId).toBe(w.aliasId);
      });
    });
  }
});
