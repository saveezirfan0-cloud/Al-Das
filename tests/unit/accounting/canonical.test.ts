import { describe, expect, it } from "vitest";

import { journalCanonical, type CanonicalJournal } from "@/lib/accounting/canonical";
import { journalContentHash } from "@/lib/accounting/journal-hash";

const base: CanonicalJournal = {
  orgId: "11111111-1111-1111-1111-111111111111",
  entityId: "22222222-2222-2222-2222-222222222222",
  voucherType: "journal",
  journalDate: "2026-07-01",
  narration: "Accrual | July\nrent",
  lines: [
    { lineNo: 2, accountId: "AAAAAAAA-0000-0000-0000-000000000002", debit: 0, credit: "100.5" },
    {
      lineNo: 1,
      accountId: "aaaaaaaa-0000-0000-0000-000000000001",
      debit: 100.5,
      credit: 0,
      branchCode: "P",
      currency: "USD",
      fxRate: 3.6725,
      amountFx: 27.37,
      description: "a\\b",
    },
  ],
};

describe("journal canonical content", () => {
  it("is the exact text the database builds (shape, escaping, order)", () => {
    expect(journalCanonical(base)).toBe(
      [
        "pulse-journal-v1",
        "org:11111111-1111-1111-1111-111111111111",
        "entity:22222222-2222-2222-2222-222222222222",
        "type:journal",
        "date:2026-07-01",
        "narration:Accrual \\| July\\nrent",
        "source:-/-/-",
        "reversal_of:-",
        "adjustment:no",
        "auto_reverse_on:-",
        "lines:2",
        "L|1|aaaaaaaa-0000-0000-0000-000000000001|100.50|0.00|-|P|-|-|-|-|-|-|-|USD|3.67250000|27.37|a\\\\b",
        "L|2|aaaaaaaa-0000-0000-0000-000000000002|0.00|100.50|-|-|-|-|-|-|-|-|-|-|-|-|-",
      ].join("\n"),
    );
  });

  it("changes its hash when anything that matters changes", () => {
    const h = journalContentHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(journalContentHash({ ...base })).toBe(h);
    expect(journalContentHash({ ...base, narration: "other" })).not.toBe(h);
    expect(journalContentHash({ ...base, autoReverseOn: "2026-08-01" })).not.toBe(h);
    expect(journalContentHash({ ...base, isAdjustment: true })).not.toBe(h);
    const lines = [...base.lines];
    lines[0] = { ...lines[0], credit: "100.51" };
    expect(journalContentHash({ ...base, lines })).not.toBe(h);
  });

  it("ends with an empty line list for a journal without lines", () => {
    expect(journalCanonical({ ...base, lines: [] }).endsWith("lines:0\n")).toBe(true);
  });
});
