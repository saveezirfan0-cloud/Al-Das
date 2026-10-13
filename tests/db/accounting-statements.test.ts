/**
 * Phase 22G: financial statements, budgets, the VAT return and ratios, database side. A synthetic ledger
 * (tests/unit/accounting/statements/ledger.synthetic.json) is posted through acc_post_from_source and two manual journals
 * (maker and checker); then the P&L (gross and net profit, branch and month columns, the adjustment-period toggle), the
 * balance sheet (balances, equals the trial balance), the cash flow (reconciles to cash and bank), the VAT 201 boxes
 * (mixed tax codes and emirates), the exceptions, the corporate tax bridge, budgets (maker / checker, hash binding,
 * immutability, budget against actual) and the Provisional label. Pure TypeScript shaping is checked against the SQL
 * totals (parity). Synthetic data only. Needs TEST_DATABASE_URL.
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildBalanceSheet, type BsData } from "@/lib/accounting/statements/balance-sheet";
import { buildBudgetVsActual, type BvaData } from "@/lib/accounting/statements/budget";
import {
  buildCashFlow,
  effectiveCashFlowClasses,
  type CfData,
} from "@/lib/accounting/statements/cash-flow";
import { ctBridge, type CtData } from "@/lib/accounting/statements/corporate-tax";
import type { ExceptionsData } from "@/lib/accounting/statements/exceptions";
import { buildProfitAndLoss, type PlData } from "@/lib/accounting/statements/profit-loss";
import { computeRatios, ratioInputs } from "@/lib/accounting/statements/ratios";
import type { StatementAccount } from "@/lib/accounting/statements/tree";
import { buildVatReturn, vatTotals, type VatData } from "@/lib/accounting/statements/vat";
import type { TrialBalanceData } from "@/lib/accounting/reports";

import fixture from "../unit/accounting/statements/ledger.synthetic.json";
import {
  asServiceRole,
  asUser,
  connect,
  createAuthUser,
  createOrg,
  resetDb,
  TEST_DATABASE_URL,
} from "./helpers";

type Line = Record<string, unknown>;
const E = fixture.expected;

describe.skipIf(!TEST_DATABASE_URL)("Accounting statements (Phase 22G)", () => {
  let c: Client;
  let orgA: string;
  let orgB: string;
  const users: Record<string, string> = {};
  const q = (sql: string, p: unknown[] = []) => c.query(sql, p);
  const svc = <T>(fn: () => Promise<T>) => asServiceRole(c, fn);
  const hint = (e: unknown) => (e as { hint?: string } | null)?.hint ?? null;
  const fails = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: unknown) => e,
    );
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) =>
    (await svc(() => q(sql, p))).rows[0] as T;
  const rpc = async <T>(fn: string, args: unknown[]): Promise<T> => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one<{ r: T }>(`select public.${fn}(${ph}) as r`, args)).r;
  };
  const num = (v: unknown) => Number(v);
  let accounts: StatementAccount[] = [];
  const idOf = (code: string) => accounts.find((a) => a.code === code)!.id;
  const codeOf = (id: string) => accounts.find((a) => a.id === id)?.code;

  const loadAccounts = async () => {
    const { rows } = await svc(() =>
      q(
        `select id, parent_id, code, name, nature, is_group, is_active, is_system, control, allow_manual,
                affects_gross_profit, sort_order, cash_flow_class, ct_treatment, tally_group
         from public.acc_accounts where org_id = $1`,
        [orgA],
      ),
    );
    accounts = rows as StatementAccount[];
  };

  const manual = async (m: { id: string; date: string; is_adjustment: boolean; lines: Line[] }) => {
    const saved = await rpc<{ id: string }>("acc_journal_save", [
      orgA,
      users.alice,
      null,
      JSON.stringify({
        voucher_type: "journal",
        journal_date: m.date,
        narration: `Synthetic manual ${m.id}`,
        is_adjustment: m.is_adjustment ? "true" : "false",
      }),
      JSON.stringify(m.lines),
    ]);
    const sub = await rpc<{ hash: string }>("acc_journal_act", [
      orgA,
      saved.id,
      users.alice,
      "submit",
      "",
    ]);
    await rpc("acc_post_journal", [orgA, saved.id, users.bob, sub.hash]);
    return saved.id;
  };

  beforeAll(async () => {
    c = await connect();
    await resetDb(c);
    for (const n of ["alice", "bob", "carol"])
      users[n] = await createAuthUser(c, `${n}-stmt@example.test`);
    orgA = await createOrg(c, "Org A", "org-a-stmt", users.alice);
    orgB = await createOrg(c, "Org B", "org-b-stmt", users.carol);
    await svc(async () => {
      await q(
        "insert into public.memberships (org_id, user_id, role_id) select $1, $2, id from public.roles where org_id = $1 and name = 'Admin'",
        [orgA, users.bob],
      );
      for (const [code, emirate] of Object.entries(fixture.emirates))
        await q(
          "update public.acc_entity_branches set emirate = $3 where org_id = $1 and branch_code = $2",
          [orgA, code, emirate],
        );
      for (const a of fixture.accounts)
        await q(
          `insert into public.acc_accounts (org_id, parent_id, code, name, nature, ct_treatment)
           select $1, p.id, $3, $4, p.nature, $5 from public.acc_accounts p where p.org_id = $1 and p.code = $2`,
          [orgA, a.parent, a.code, a.name, (a as { ct_treatment?: string }).ct_treatment ?? null],
        );
      for (const f of fixture.flags as Array<Record<string, unknown>>)
        await q(
          `update public.acc_accounts set requires_branch = $3, requires_cost_centre = $4, ct_treatment = coalesce($5, ct_treatment)
           where org_id = $1 and code = $2`,
          [orgA, f.code, !!f.requires_branch, !!f.requires_cost_centre, f.ct_treatment ?? null],
        );
      await q(
        `insert into public.fin_ref_finance_settings (org_id, acc_large_journal_amount) values ($1, 1000)
         on conflict (org_id) do update set acc_large_journal_amount = 1000`,
        [orgA],
      );
      // 22D's ledger start rule refuses manual journals until the date is set (22K)
      await q(
        "update public.acc_entities set ledger_start_date = '2000-01-01' where org_id in ($1, $2)",
        [orgA, orgB],
      );
    });
    for (const p of fixture.postings)
      await rpc("acc_post_from_source", [
        orgA,
        null,
        "tally_import",
        p.id,
        1,
        p.date,
        p.type,
        `Synthetic ${p.id}`,
        JSON.stringify(p.lines),
      ]);
    for (const m of fixture.manual) await manual(m);
    // org B: one posting that must never show in org A's statements
    await rpc("acc_post_from_source", [
      orgB,
      null,
      "tally_import",
      "B1",
      1,
      "2026-07-05",
      "sales",
      "Synthetic B1",
      JSON.stringify([
        { account_code: "1210", debit: 999 },
        { account_code: "4100", credit: 999, tax_code: "VAT5" },
      ]),
    ]);
    await loadAccounts();
  });
  afterAll(async () => {
    await resetDb(c);
    await c.end();
  });

  const { from, to } = E.q1;

  describe("profit and loss", () => {
    it("gives gross and net profit in Tally's layout, and the TS shaping agrees", async () => {
      const pl = await rpc<PlData>("acc_profit_and_loss", [orgA, null, from, to, "none", true]);
      const t = pl.totals.find((x) => x.col === "total")!;
      for (const [k, v] of Object.entries(E.pl)) expect(num(t[k as keyof typeof t]), k).toBe(v);
      const shaped = buildProfitAndLoss(accounts, pl);
      expect(shaped.grossProfit).toEqual([E.pl.gross_profit]);
      expect(shaped.netProfit).toEqual([E.pl.net_profit]);
      expect(shaped.sections.indirect_expense).toEqual([E.pl.indirect_expense]);
      expect(pl.provisional).toBe(true);
    });

    it("splits by branch and by month; the columns add up to the total", async () => {
      const br = await rpc<PlData>("acc_profit_and_loss", [orgA, null, from, to, "branch", true]);
      for (const [col, exp] of Object.entries(E.pl_by_branch)) {
        const t = br.totals.find((x) => x.col === col)!;
        for (const [k, v] of Object.entries(exp))
          expect(num(t[k as keyof typeof t]), `${col} ${k}`).toBe(v);
      }
      expect(br.labels[""]).toBe("Not set");
      const shaped = buildProfitAndLoss(accounts, br, { extra: "total" });
      expect(shaped.netProfit.reduce((s, x) => s + x, 0)).toBeCloseTo(E.pl.net_profit, 2);
      // parity per column
      br.columns.forEach((col, i) =>
        expect(shaped.netProfit[i]).toBeCloseTo(
          num(br.totals.find((x) => x.col === col)!.net_profit),
          2,
        ),
      );
      const mo = await rpc<PlData>("acc_profit_and_loss", [orgA, null, from, to, "month", true]);
      for (const [m, v] of Object.entries(E.pl_by_month))
        expect(num(mo.totals.find((x) => x.col === m)!.net_profit), m).toBe(v);
    });

    it("includes or leaves out the adjustment period", async () => {
      const withAdj = await rpc<PlData>("acc_profit_and_loss", [
        orgA,
        null,
        E.ct.fy_from,
        E.ct.fy_to,
        "none",
        true,
      ]);
      const without = await rpc<PlData>("acc_profit_and_loss", [
        orgA,
        null,
        E.ct.fy_from,
        E.ct.fy_to,
        "none",
        false,
      ]);
      expect(num(withAdj.totals[0].net_profit)).toBe(E.ct.accounting_profit);
      expect(num(without.totals[0].net_profit)).toBe(E.pl.net_profit);
    });

    it("refuses a bad range or dimension", async () => {
      expect(
        hint(await fails(rpc("acc_profit_and_loss", [orgA, null, to, from, "none", true]))),
      ).toBe("invalid");
      expect(
        hint(await fails(rpc("acc_profit_and_loss", [orgA, null, from, to, "patient", true]))),
      ).toBe("invalid");
    });
  });

  describe("balance sheet", () => {
    it("balances, shows the year's profit in equity, and equals the trial balance", async () => {
      const bs = await rpc<BsData>("acc_balance_sheet", [orgA, null, E.bs.as_at, true]);
      expect(num(bs.totals.assets)).toBe(E.bs.assets);
      expect(num(bs.totals.liabilities)).toBe(E.bs.liabilities);
      expect(num(bs.totals.equity)).toBe(E.bs.equity);
      expect(num(bs.current_year_pl)).toBe(E.bs.current_year_pl);
      expect(num(bs.earlier_years_pl)).toBe(E.bs.earlier_years_pl);
      expect(num(bs.totals.difference)).toBe(0);
      const byCode = Object.fromEntries(bs.rows.map((r) => [codeOf(r.account_id), num(r.balance)]));
      for (const [code, v] of Object.entries(E.bs.balances)) expect(byCode[code], code).toBe(v);
      const shaped = buildBalanceSheet(accounts, [bs]);
      expect(shaped.balanced).toBe(true);
      expect(shaped.assets).toEqual([E.bs.assets]);
      expect(shaped.capitalAndLiabilities).toEqual([E.bs.assets]);
      // equals the trial balance's closing balances
      const tb = await rpc<TrialBalanceData>("acc_trial_balance", [
        orgA,
        null,
        bs.fy_start,
        E.bs.as_at,
      ]);
      for (const r of tb.rows) {
        if (!["asset", "liability", "equity"].includes(r.nature)) continue;
        const sign = r.nature === "asset" ? 1 : -1;
        expect(byCode[r.code] ?? 0, r.code).toBeCloseTo(sign * num(r.closing), 2);
      }
    });

    it("never shows another org's postings", async () => {
      const bs = await rpc<BsData>("acc_balance_sheet", [orgA, null, E.bs.as_at, true]);
      expect(num(bs.totals.assets)).toBe(E.bs.assets);
      const b = await rpc<BsData>("acc_balance_sheet", [orgB, null, E.bs.as_at, true]);
      expect(num(b.totals.assets)).toBe(999);
    });
  });

  describe("cash flow", () => {
    it("reconciles the indirect method to the cash and bank movement", async () => {
      const cf = await rpc<CfData>("acc_cash_flow", [orgA, null, from, to, true]);
      for (const [k, v] of Object.entries(E.cf))
        expect(num(cf.totals[k as keyof CfData["totals"]]), k).toBe(v);
      expect(num(cf.totals.difference)).toBe(0);
      const shaped = buildCashFlow(accounts, cf);
      expect(shaped.reconciles).toBe(true);
      expect(shaped.netChange).toBe(E.cf.net_change);
      // the depreciation is added back through accumulated depreciation (seeded as a non-cash item)
      expect(cf.rows.find((r) => codeOf(r.account_id) === "1590")?.class).toBe("operating_noncash");
    });

    it("classifies every account the same way in SQL and TypeScript", async () => {
      const cf = await rpc<CfData>("acc_cash_flow", [orgA, null, from, to, true]);
      const ts = effectiveCashFlowClasses(accounts);
      for (const a of accounts) expect(ts.get(a.id) ?? null, a.code).toBe(cf.classes[a.id] ?? null);
      // an override on a ledger wins over its group
      await svc(() =>
        q(
          "update public.acc_accounts set cash_flow_class = 'financing' where org_id = $1 and code = '9000'",
          [orgA],
        ),
      );
      const cf2 = await rpc<CfData>("acc_cash_flow", [orgA, null, from, to, true]);
      expect(cf2.classes[idOf("9000")]).toBe("financing");
      expect(num(cf2.totals.financing)).toBe(E.cf.financing + 1500);
      expect(num(cf2.totals.difference)).toBe(0);
      await svc(() =>
        q(
          "update public.acc_accounts set cash_flow_class = null where org_id = $1 and code = '9000'",
          [orgA],
        ),
      );
    });
  });

  describe("VAT return", () => {
    it("fills the boxes from mixed tax codes and emirates", async () => {
      const vat = await rpc<VatData>("acc_vat_return", [orgA, null, from, to]);
      for (const [box, exp] of Object.entries(E.vat.boxes)) {
        const b = vat.boxes.find((x) => x.box === box)!;
        for (const [k, v] of Object.entries(exp))
          expect(num(b[k as keyof typeof b]), `${box} ${k}`).toBe(v);
        if (["1a", "1b", "3", "9", "10"].includes(box))
          expect(num(b.expected_vat), box).toBe(num(b.vat));
      }
      expect(num(vat.totals.box8_amount)).toBe(E.vat.box8_amount);
      expect(num(vat.totals.box8_vat)).toBe(E.vat.box8_vat);
      expect(num(vat.totals.box11_amount)).toBe(E.vat.box11_amount);
      expect(num(vat.totals.box11_vat)).toBe(E.vat.box11_vat);
      expect(num(vat.totals.box14)).toBe(E.vat.box14);
      // the TypeScript totals agree with SQL
      const ts = vatTotals(vat.boxes);
      for (const k of Object.keys(vat.totals) as Array<keyof VatData["totals"]>)
        expect(ts[k], k).toBeCloseTo(num(vat.totals[k]), 2);
      expect([...new Set(vat.missing_tax_code.map((m) => m.account_code))].sort()).toEqual(
        E.vat.missing_accounts,
      );
      expect(vat.lines.filter((l) => l.box === "1b")).toHaveLength(4);
      const built = buildVatReturn(vat);
      expect(built.checks.defaultedLines).toBe(2);
      expect(built.checks.missing).toBe(4);
      expect(built.checks.vatMismatch).toBe(false);
    });

    it("uses the entity's default emirate for a line without a branch", async () => {
      await svc(() =>
        q("update public.acc_entities set default_emirate = 'Sharjah' where org_id = $1", [orgA]),
      );
      const vat = await rpc<VatData>("acc_vat_return", [orgA, null, from, to]);
      expect(num(vat.boxes.find((b) => b.box === "1c")!.amount)).toBe(200);
      expect(num(vat.boxes.find((b) => b.box === "1b")!.amount)).toBe(1000);
      await svc(() =>
        q("update public.acc_entities set default_emirate = 'Dubai' where org_id = $1", [orgA]),
      );
    });
  });

  describe("exceptions", () => {
    it("lists negative cash, opposite balances, suspense, large manual journals and missing dimensions", async () => {
      const x = await rpc<ExceptionsData>("acc_statement_exceptions", [orgA, null, from, to]);
      expect(
        x.negative_cash.map((r) => ({ code: r.code, date: r.date, balance: num(r.balance) })),
      ).toEqual(E.exceptions.negative_cash);
      expect(x.opposite_balances.map((r) => r.code).sort()).toEqual(E.exceptions.opposite);
      expect(x.suspense.map((r) => ({ code: r.code, balance: num(r.balance) }))).toEqual(
        E.exceptions.suspense,
      );
      expect(x.large_manual).toHaveLength(E.exceptions.large_manual_numbers);
      expect(num(x.large_journal_amount)).toBe(1000);
      const nd = x.missing_dimension
        .map((r) => ({
          code: r.code,
          ...(r.no_branch ? { no_branch: true } : {}),
          ...(r.no_cost_centre ? { no_cost_centre: true } : {}),
        }))
        .sort((a, b) => (a.code < b.code ? -1 : 1));
      expect(nd).toEqual(E.exceptions.missing_dimension);
      expect(x.late_postings).toHaveLength(0);
      const fy = await rpc<ExceptionsData>("acc_statement_exceptions", [
        orgA,
        null,
        E.ct.fy_from,
        E.ct.fy_to,
      ]);
      expect(fy.late_postings.map((r) => r.is_adjustment)).toEqual([true]);
    });
  });

  describe("corporate tax bridge", () => {
    it("sums profit, revenue and the tagged expenses", async () => {
      const ct = await rpc<CtData>("acc_ct_bridge", [orgA, null, E.ct.fy_from, E.ct.fy_to]);
      expect(num(ct.accounting_profit)).toBe(E.ct.accounting_profit);
      expect(num(ct.revenue)).toBe(E.ct.revenue);
      expect(num(ct.by_treatment.entertainment)).toBe(E.ct.entertainment);
      expect(num(ct.by_treatment.fines_penalties)).toBe(E.ct.fines_penalties);
      expect(num(ct.settings.ct_rate)).toBe(9);
      const b = ctBridge(
        {
          ...ct,
          settings: Object.fromEntries(
            Object.entries(ct.settings).map(([k, v]) => [k, num(v)]),
          ) as CtData["settings"],
        },
        { otherAddBacks: 0, otherDeductions: 0 },
      );
      expect(b.addBacks).toBe(157.5 + 600);
      expect(b.tax).toBe(0);
    });
  });

  describe("ratios", () => {
    it("work out from the statements' own figures", async () => {
      const bs = await rpc<BsData>("acc_balance_sheet", [orgA, null, to, true]);
      const pl = await rpc<PlData>("acc_profit_and_loss", [orgA, null, from, to, "none", true]);
      const i = ratioInputs(accounts, bs, pl, null);
      expect(i.currentAssets).toBe(105785 - 75 + 1000 + 1260);
      expect(i.currentLiabilities).toBe(800 + 135 - 150);
      expect(i.receivables).toBe(2260);
      expect(i.payables).toBe(800);
      const r = computeRatios(i);
      expect(r.currentRatio).toBe(Math.round((107970 / 785) * 100) / 100);
      expect(r.grossMarginPct).toBe(Math.round((3900 / 4700) * 1000) / 10);
      expect(r.revenuePerPatient).toBeNull();
    });
  });

  describe("budgets", () => {
    let budgetId: string;
    it("are prepared by one person and approved by another, bound to the content", async () => {
      const saved = await rpc<{ id: string; lines: number }>("acc_budget_save", [
        orgA,
        users.alice,
        null,
        JSON.stringify({ fy_start: "2026-07-01", name: "Synthetic FY 2026-27" }),
        JSON.stringify(E.budget.lines),
      ]);
      budgetId = saved.id;
      expect(saved.lines).toBe(4);
      // not a person with the budgets key (another org's owner)
      expect(
        hint(
          await fails(
            rpc("acc_budget_save", [
              orgA,
              users.carol,
              null,
              JSON.stringify({ fy_start: "2026-07-01", name: "X" }),
              "[]",
            ]),
          ),
        ),
      ).toBe("not_permitted");
      // bad lines
      const bad = (lines: Line[]) =>
        fails(
          rpc("acc_budget_save", [
            orgA,
            users.alice,
            null,
            JSON.stringify({ fy_start: "2026-07-01", name: `Bad ${Math.random()}` }),
            JSON.stringify(lines),
          ]),
        ).then(hint);
      expect(await bad([{ account_code: "1150", month: "2026-07", amount: 1 }])).toBe(
        "budget_account",
      );
      expect(await bad([{ account_code: "6200", month: "2027-07", amount: 1 }])).toBe(
        "budget_month",
      );
      expect(await bad([{ account_code: "6200", month: "2026-07", amount: 1.001 }])).toBe(
        "invalid",
      );
      expect(
        await bad([
          { account_code: "6200", month: "2026-07", amount: 1 },
          { account_code: "6200", month: "2026-07", amount: 2 },
        ]),
      ).toBe("duplicate_line");
      expect(
        hint(
          await fails(
            rpc("acc_budget_save", [
              orgA,
              users.alice,
              null,
              JSON.stringify({ fy_start: "2026-08-01", name: "Y" }),
              "[]",
            ]),
          ),
        ),
      ).toBe("invalid");

      const hash = await rpc<string>("acc_budget_hash", [budgetId]);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        hint(await fails(rpc("acc_budget_act", [orgA, budgetId, users.alice, "approve", hash]))),
      ).toBe("budget_same_person");
      expect(
        hint(
          await fails(
            rpc("acc_budget_act", [orgA, budgetId, users.bob, "approve", "0".repeat(64)]),
          ),
        ),
      ).toBe("budget_hash_mismatch");
      const ok = await rpc<{ status: string; sha256: string }>("acc_budget_act", [
        orgA,
        budgetId,
        users.bob,
        "approve",
        hash,
      ]);
      expect(ok).toMatchObject({ status: "approved", sha256: hash });
      // approved: lines never change, for any role
      expect(
        hint(
          await fails(
            svc(() =>
              q("update public.acc_budget_lines set amount = 1 where budget_id = $1", [budgetId]),
            ),
          ),
        ),
      ).toBe("budget_approved");
      expect(
        hint(
          await fails(
            rpc("acc_budget_save", [
              orgA,
              users.alice,
              budgetId,
              JSON.stringify({ fy_start: "2026-07-01", name: "Z" }),
              "[]",
            ]),
          ),
        ),
      ).toBe("budget_approved");
      // the table's CHECK repeats the different-person rule
      expect(
        await fails(
          svc(() =>
            q("update public.acc_budgets set approved_by = prepared_by where id = $1", [budgetId]),
          ),
        ),
      ).not.toBeNull();
    });

    it("reopening returns it to draft with the reopener as preparer", async () => {
      const r = await rpc<{ status: string }>("acc_budget_act", [
        orgA,
        budgetId,
        users.bob,
        "reopen",
        null,
      ]);
      expect(r.status).toBe("draft");
      const b = await one<{ prepared_by: string; approved_by: string | null }>(
        "select prepared_by, approved_by from public.acc_budgets where id = $1",
        [budgetId],
      );
      expect(b).toEqual({ prepared_by: users.bob, approved_by: null });
      const hash = await rpc<string>("acc_budget_hash", [budgetId]);
      await rpc("acc_budget_act", [orgA, budgetId, users.alice, "approve", hash]);
    });

    it("compares with the actuals and highlights adverse lines", async () => {
      const bva = await rpc<BvaData>("acc_budget_vs_actual", [
        orgA,
        budgetId,
        "2026-07-01",
        "2026-07-31",
        null,
        null,
      ]);
      for (const [k, v] of Object.entries(E.budget.jul))
        expect(num(bva.totals[k as keyof BvaData["totals"]]), k).toBe(v);
      expect(num(bva.threshold_pct)).toBe(10);
      const shaped = buildBudgetVsActual(accounts, {
        ...bva,
        threshold_pct: num(bva.threshold_pct),
        rows: bva.rows.map((r) => ({ ...r, budget: num(r.budget), actual: num(r.actual) })),
      });
      expect(shaped.adverseCount).toBe(2); // 4100 under budget by 40%, 6200 over by 100%
      const g = await rpc<BvaData>("acc_budget_vs_actual", [
        orgA,
        budgetId,
        "2026-08-01",
        "2026-08-31",
        "G",
        null,
      ]);
      expect(num(g.totals.budget_expense)).toBe(1000);
      expect(num(g.totals.actual_expense)).toBe(800);
      // a range outside the budget's year means the whole year
      const whole = await rpc<BvaData>("acc_budget_vs_actual", [
        orgA,
        budgetId,
        "2025-01-01",
        "2025-01-31",
        null,
        null,
      ]);
      expect([whole.from, whole.to]).toEqual(["2026-07-01", "2027-06-30"]);
    });

    it("are visible to accounting readers of the org only (RLS)", async () => {
      await asUser(c, users.carol, async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.acc_budgets where org_id = $1",
          [orgA],
        );
        expect(rows[0].n).toBe(0);
      });
      await asUser(c, users.alice, async () => {
        const { rows } = await q(
          "select count(*)::int as n from public.acc_budget_lines where org_id = $1",
          [orgA],
        );
        expect(rows[0].n).toBe(4);
      });
    });

    it("cannot be deleted once approved; a draft can", async () => {
      expect(
        hint(await fails(rpc("acc_budget_act", [orgA, budgetId, users.alice, "delete", null]))),
      ).toBe("budget_approved");
      await rpc("acc_budget_act", [orgA, budgetId, users.alice, "reopen", null]);
      await rpc("acc_budget_act", [orgA, budgetId, users.alice, "delete", null]);
      expect(
        await one("select id from public.acc_budgets where id = $1", [budgetId]),
      ).toBeUndefined();
    });
  });

  describe("provisional", () => {
    it("is lifted once every month in range is closed", async () => {
      const periods = (
        await svc(() =>
          q(
            "select id from public.acc_periods where org_id = $1 and not is_adjustment and start_date between $2 and $3",
            [orgA, from, to],
          ),
        )
      ).rows as Array<{ id: string }>;
      expect(periods).toHaveLength(3);
      for (const p of periods)
        await rpc("acc_set_period_status", [orgA, p.id, users.alice, "closed"]);
      const pl = await rpc<PlData>("acc_profit_and_loss", [orgA, null, from, to, "none", true]);
      expect(pl.provisional).toBe(false);
      const longer = await rpc<PlData>("acc_profit_and_loss", [
        orgA,
        null,
        from,
        "2026-10-31",
        "none",
        true,
      ]);
      expect(longer.provisional).toBe(true);
    });
  });
});
