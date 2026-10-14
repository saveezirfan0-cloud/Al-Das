import { describe, expect, it } from "vitest";

import {
  accountProblems,
  descendantIds,
  flattenTree,
  manualAllowed,
  postableAccounts,
  type AccountRow,
} from "@/lib/accounting/accounts";
import {
  buildTrialBalance,
  drCr,
  ledgerConsistent,
  rangeProblem,
  type TrialBalanceRow,
} from "@/lib/accounting/reports";
import { natureForTallyGroup, TALLY_GROUPS } from "@/lib/accounting/tally-groups";
import { kindHasRate, vatOn } from "@/lib/accounting/tax";

const acc = (
  id: string,
  parent: string | null,
  code: string,
  isGroup: boolean,
  extra: Partial<AccountRow> = {},
): AccountRow => ({
  id,
  parent_id: parent,
  code,
  name: `Name ${code}`,
  nature: "asset",
  is_group: isGroup,
  is_active: true,
  is_system: isGroup,
  control: null,
  allow_manual: true,
  ...extra,
});

const chart: AccountRow[] = [
  acc("ca", null, "G-CA", true, { sort_order: 20 }),
  acc("debt", "ca", "G-DEBT", true, { sort_order: 320 }),
  acc("cash", "ca", "G-CASH", true, { sort_order: 230 }),
  acc("1210", "debt", "1210", false),
  acc("1100", "cash", "1100", false, { control: "cash" }),
  acc("sal", null, "G-SAL", true, { nature: "income", sort_order: 130 }),
  acc("4100", "sal", "4100", false, { nature: "income", is_active: false }),
];

describe("account tree", () => {
  it("orders groups before ledgers, by sort order, with depth and path", () => {
    const t = flattenTree(chart);
    expect(t.map((a) => a.code)).toEqual([
      "G-CA",
      "G-CASH",
      "1100",
      "G-DEBT",
      "1210",
      "G-SAL",
      "4100",
    ]);
    expect(t.find((a) => a.code === "1210")).toMatchObject({
      depth: 2,
      path: ["Name G-CA", "Name G-DEBT"],
    });
  });

  it("offers active ledgers only, and control accounts only in opening balances", () => {
    expect(postableAccounts(chart).map((a) => a.code)).toEqual(["1100", "1210"]);
    expect(manualAllowed({ control: "cash", allow_manual: true }, false)).toBe(false);
    expect(manualAllowed({ control: "cash", allow_manual: true }, true)).toBe(true);
    expect(manualAllowed({ control: null, allow_manual: false }, false)).toBe(false);
  });

  it("checks a new account before it reaches the database", () => {
    expect(
      accountProblems(
        { code: "6210", isGroup: false, parentId: "x", control: null },
        { is_group: true },
      ),
    ).toEqual([]);
    expect(
      accountProblems(
        { code: "bad code", isGroup: false, parentId: "x", control: null },
        { is_group: true },
      ),
    ).toEqual(["invalid"]);
    expect(
      accountProblems(
        { code: "6210", isGroup: false, parentId: "x", control: null },
        { is_group: false },
      ),
    ).toEqual(["parent_not_group"]);
    expect(
      accountProblems(
        { code: "G1", isGroup: true, parentId: "x", control: "cash" },
        { is_group: true },
      ),
    ).toEqual(["invalid"]);
    expect([...descendantIds(chart, "ca")].sort()).toEqual(["1100", "1210", "cash", "debt"]);
  });
});

describe("Tally groups", () => {
  it("lists Tally's 28 predefined groups: 15 primary and 13 sub-groups under primary ones of the same nature", () => {
    expect(TALLY_GROUPS).toHaveLength(28);
    const primary = TALLY_GROUPS.filter((g) => g.parent === null);
    expect(primary).toHaveLength(15);
    for (const g of TALLY_GROUPS.filter((x) => x.parent)) {
      const p = TALLY_GROUPS.find((x) => x.code === g.parent)!;
      expect(p.parent, g.name).toBeNull();
      expect(p.nature, g.name).toBe(g.nature);
    }
    expect(new Set(TALLY_GROUPS.map((g) => g.name)).size).toBe(28);
  });

  it("marks the gross-profit groups as Tally does, and maps Capital Account to equity", () => {
    expect(
      TALLY_GROUPS.filter((g) => g.grossProfit)
        .map((g) => g.name)
        .sort(),
    ).toEqual(["Direct Expenses", "Direct Incomes", "Purchase Accounts", "Sales Accounts"]);
    expect(natureForTallyGroup("capital account")).toBe("equity");
    expect(TALLY_GROUPS.find((g) => g.name === "Capital Account")!.tallyNature).toBe("Liabilities");
    expect(natureForTallyGroup("Sundry Debtors")).toBe("asset");
    expect(natureForTallyGroup("My ledger group")).toBeNull();
  });
});

describe("trial balance shaping", () => {
  const row = (id: string, parent: string, o: number, d: number, c: number): TrialBalanceRow => ({
    account_id: id,
    code: id,
    name: id,
    nature: "asset",
    parent_id: parent,
    opening: o,
    debit: d,
    credit: c,
    closing: o + d - c,
  });

  it("sums ledgers into every group above them and checks the balance", () => {
    const tb = buildTrialBalance(chart, {
      rows: [
        row("1210", "debt", 100, 50, 0),
        row("1100", "cash", 0, 0.1, 0),
        row("4100", "sal", 0, 0, 50.1),
      ],
      earlier_years_pl: -100,
    });
    const by = new Map(tb.lines.map((l) => [l.code, l]));
    expect(by.get("G-CA")).toMatchObject({ opening: 100, debit: 50.1, credit: 0, closing: 150.1 });
    expect(by.get("G-SAL")).toMatchObject({ closing: -50.1 });
    expect(tb.totals).toEqual({ opening: 0, debit: 50.1, credit: 50.1, closing: 0 });
    expect(tb.balanced).toBe(true);
    expect(
      buildTrialBalance(chart, { rows: [row("1210", "debt", 0, 5, 0)], earlier_years_pl: 0 })
        .balanced,
    ).toBe(false);
    expect(
      buildTrialBalance(
        chart,
        { rows: [row("1210", "debt", 0, 5, 0)], earlier_years_pl: 0 },
        { groupsOnly: true },
      ).lines.every((l) => l.isGroup),
    ).toBe(true);
  });

  it("shows a balance with its side, and checks a ledger page's running balance", () => {
    expect(drCr(12.5)).toEqual({ amount: 12.5, side: "Dr" });
    expect(drCr(-3)).toEqual({ amount: 3, side: "Cr" });
    expect(drCr(0.001)).toEqual({ amount: 0, side: "" });
    const lines = [
      { debit: 10, credit: 0, balance: 15 },
      { debit: 0, credit: 20, balance: -5 },
    ] as never;
    expect(ledgerConsistent({ opening: 5, offset: 0, lines })).toBe(true);
    expect(ledgerConsistent({ opening: 6, offset: 0, lines })).toBe(false);
  });

  it("checks date ranges", () => {
    expect(rangeProblem("2026-07-01", "2026-07-31")).toBeNull();
    expect(rangeProblem("2026-08-01", "2026-07-31")).toMatch(/after/);
    expect(rangeProblem("2026-13-01", "2026-07-31")).toMatch(/valid/);
    expect(rangeProblem("2020-01-01", "2026-07-31", 366)).toMatch(/shorter/);
  });
});

describe("VAT", () => {
  it("knows which kinds carry a rate and rounds VAT to fils", () => {
    expect(kindHasRate("standard")).toBe(true);
    expect(kindHasRate("blocked")).toBe(true);
    expect(kindHasRate("zero")).toBe(false);
    expect(vatOn(100, 5)).toBe(5);
    expect(vatOn(10.1, 5)).toBe(0.51);
  });
});
