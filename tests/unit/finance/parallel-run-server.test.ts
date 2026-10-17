import { describe, expect, it, vi } from "vitest";

import { loadParallelView } from "@/lib/finance/parallel-run-server";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * W4 loader with a fake client: which areas a member sees, where each Pulse figure comes from, "not available yet"
 * instead of zero, the strict tolerance fallback, and a switched area that stopped agreeing keeping its status.
 */

type Rows = Record<string, unknown[]>;

function fake(tables: Rows, rpcs: { closeFails?: boolean } = {}) {
  const from = (table: string) => {
    const rows = tables[table] ?? [];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      gte: () => q,
      in: () => q,
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) => res({ data: rows, error: null }),
    };
    return q;
  };
  const rpc = vi.fn(async (name: string) => {
    if (rpcs.closeFails) return { data: null, error: { code: "XX000" } };
    if (name === "fin_close_month_figures")
      return {
        data: {
          by_branch: [{ outstanding: 100.5 }, { outstanding: 50 }],
          collections: [
            { mode: "cash", paid: 40, refunds: 1 },
            { mode: "card", paid: 60.25, refunds: 0 },
          ],
        },
        error: null,
      };
    // fin_revenue_breakdown, by category
    return {
      data: [
        { key: "a", label: "A", net: 700, invoices: 3, gross: 700, discount: 0, vat: 0, lines: 3 },
        {
          key: "b",
          label: "B",
          net: 300.125,
          invoices: 1,
          gross: 300.125,
          discount: 0,
          vat: 0,
          lines: 1,
        },
      ],
      error: null,
    };
  });
  return { admin: { from, rpc } as unknown as AdminClient, rpc };
}

const member = (permissions: string[]) => ({
  userId: "u",
  orgId: "org",
  roleId: "r",
  status: "active" as const,
  permissions,
});

// "today" 2026-10-17: the last finished month is 2026-09, the window runs back to 2026-04
const TODAY = "2026-10-17";
const fig = (area: string, month: string, amount: number) => ({
  area,
  month: `${month}-01`,
  manual_amount: amount,
  note: null,
  entered_at: "2026-10-01T00:00:00Z",
});

describe("loadParallelView", () => {
  it("shows an area only to a member holding its own report key", async () => {
    const { admin, rpc } = fake({});
    const v = await loadParallelView(admin, member(["finance.labs.view"]), TODAY);
    expect(v.areas.map((a) => a.area)).toEqual(["labs"]);
    expect(rpc).toHaveBeenCalled(); // labs sits beside the others in one loader, but only labs is returned
    const none = await loadParallelView(fake({}).admin, member(["finance.view"]), TODAY);
    expect(none.areas).toEqual([]);
  });

  it("takes revenue, collections and insurance from the close pack's own inputs", async () => {
    const { admin } = fake({
      fin_ref_finance_settings: [{ parallel_tolerance: 1 }],
      fin_parallel_figures: [
        fig("revenue", "2026-09", 1000.125),
        fig("collections", "2026-09", 100.25),
        fig("insurance", "2026-09", 151),
      ],
    });
    const v = await loadParallelView(
      admin,
      member(["finance.revenue.view", "finance.claims.view"]),
      TODAY,
    );
    const sep = (area: string) => v.areas.find((a) => a.area === area)!.months[0];
    expect(sep("revenue")).toMatchObject({
      month: "2026-09",
      pulse: 1000.125,
      manual: 1000.125,
      state: "agrees",
    });
    expect(sep("collections")).toMatchObject({ pulse: 100.25, state: "agrees" });
    expect(sep("insurance")).toMatchObject({
      pulse: 150.5,
      manual: 151,
      difference: -0.5,
      state: "agrees",
    });
    expect(sep("revenue").provisional).toBe(true);
    expect(v.lockLabel).toMatch(/^Provisional/);
  });

  it("shows a month nobody typed in as no manual figure, and bank and labs as not available", async () => {
    const { admin } = fake({ fin_ref_finance_settings: [{ parallel_tolerance: 1 }] });
    const v = await loadParallelView(
      admin,
      member(["finance.revenue.view", "finance.bank.view", "finance.labs.view"]),
      TODAY,
    );
    const rev = v.areas.find((a) => a.area === "revenue")!;
    expect(rev.months).toHaveLength(6);
    expect(rev.months.every((m) => m.state === "no_manual" && m.manual === null)).toBe(true);
    expect(rev.status).toBe("not_started");
    expect(rev.check.ok).toBe(false);
    for (const area of ["bank", "labs"]) {
      const a = v.areas.find((x) => x.area === area)!;
      expect(a.months[0].pulse).toBeNull();
    }
  });

  it("sums reviewed bank reconciliations and lab statements only when every active account or provider has one", async () => {
    const { admin } = fake({
      fin_ref_finance_settings: [{ parallel_tolerance: 1 }],
      fin_bank_accounts: [{ id: "b1" }, { id: "b2" }],
      fin_bank_recs: [
        { account_id: "b1", month: "2026-09-01", figures: { summary: { matchedBank: 10 } } },
        { account_id: "b2", month: "2026-09-01", figures: { summary: { matchedBank: 5.5 } } },
        { account_id: "b1", month: "2026-08-01", figures: { summary: { matchedBank: 99 } } },
      ],
      fin_providers: [{ id: "p1" }],
      fin_provider_statements: [
        { provider_id: "p1", month: "2026-09-01", figures: { summary: { totalCost: 77 } } },
      ],
      fin_parallel_figures: [fig("bank", "2026-09", 15.5), fig("labs", "2026-09", 70)],
    });
    const v = await loadParallelView(
      admin,
      member(["finance.bank.view", "finance.labs.view"]),
      TODAY,
    );
    const bank = v.areas.find((a) => a.area === "bank")!.months;
    expect(bank[0]).toMatchObject({ pulse: 15.5, state: "agrees" });
    expect(bank[1].pulse).toBeNull(); // 2026-08: only one of two accounts
    const labs = v.areas.find((a) => a.area === "labs")!.months;
    expect(labs[0]).toMatchObject({ pulse: 77, manual: 70, difference: 7, state: "differs" });
  });

  it("uses a zero tolerance when the org has no settings row", async () => {
    const { admin } = fake({ fin_parallel_figures: [fig("revenue", "2026-09", 1000.124)] });
    const v = await loadParallelView(admin, member(["finance.revenue.view"]), TODAY);
    expect(v.tolerance).toBe(0);
    expect(v.areas[0].months[0].state).toBe("differs");
  });

  it("a Pulse figure that cannot be read is not available, never zero", async () => {
    const { admin } = fake(
      {
        fin_ref_finance_settings: [{ parallel_tolerance: 1000000 }],
        fin_parallel_figures: [fig("revenue", "2026-09", 0)],
      },
      { closeFails: true },
    );
    const v = await loadParallelView(admin, member(["finance.revenue.view"]), TODAY);
    expect(v.areas[0].months[0]).toMatchObject({ pulse: null, state: "no_pulse" });
  });

  it("two consecutive agreeing months allow the switch; a switched area that stops agreeing warns and stays switched", async () => {
    const tables: Rows = {
      fin_ref_finance_settings: [{ parallel_tolerance: 1 }],
      fin_parallel_figures: [
        fig("revenue", "2026-09", 1000.125),
        fig("revenue", "2026-08", 1000.125),
      ],
    };
    let v = await loadParallelView(fake(tables).admin, member(["finance.revenue.view"]), TODAY);
    expect(v.areas[0].check.ok).toBe(true);
    expect(v.areas[0].status).toBe("running");

    tables.fin_parallel_decisions = [
      {
        area: "revenue",
        status: "switched",
        decided_by: "p",
        decided_at: "2026-10-02T00:00:00Z",
        note: null,
      },
    ];
    tables.profiles = [{ id: "p", first_name: "Sam", last_name: "Demo" }];
    v = await loadParallelView(fake(tables).admin, member(["finance.revenue.view"]), TODAY);
    expect(v.areas[0]).toMatchObject({
      status: "switched",
      decidedByName: "Sam Demo",
      warning: null,
    });

    tables.fin_parallel_figures = [
      fig("revenue", "2026-09", 5000),
      fig("revenue", "2026-08", 1000.125),
    ];
    v = await loadParallelView(fake(tables).admin, member(["finance.revenue.view"]), TODAY);
    expect(v.areas[0].status).toBe("switched");
    expect(v.areas[0].warning).toContain("no longer agree");
  });

  it("marks a locked month as final", async () => {
    const { admin } = fake({
      fin_ref_finance_settings: [{ parallel_tolerance: 1 }],
      fin_period_closes: ["09", "08", "07", "06", "05", "04"].map((m) => ({
        month: `2026-${m}-01`,
      })),
    });
    const v = await loadParallelView(admin, member(["finance.revenue.view"]), TODAY);
    expect(v.areas[0].months.every((m) => !m.provisional)).toBe(true);
    expect(v.lockLabel).toMatch(/^Final/);
  });
});
