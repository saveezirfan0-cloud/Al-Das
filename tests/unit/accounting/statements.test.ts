/**
 * Phase 22G pure shaping: comparison ranges, the P&L tree and totals, the balance sheet (and its difference warning), cash
 * flow classes and the reconciliation, VAT boxes and periods, budget CSVs and variances, ratios, the corporate tax bridge,
 * the query options and the Excel / PDF renderers. Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import { buildBalanceSheet, type BsData } from "@/lib/accounting/statements/balance-sheet";
import {
  buildBudgetVsActual,
  fiscalMonths,
  parseBudgetCsv,
  variance,
  type BvaData,
} from "@/lib/accounting/statements/budget";
import {
  buildCashFlow,
  cashFlowDefault,
  effectiveCashFlowClasses,
  effectLabel,
  type CfData,
} from "@/lib/accounting/statements/cash-flow";
import { ctBridge, type CtData } from "@/lib/accounting/statements/corporate-tax";
import {
  buildExceptions,
  exceptionCount,
  type ExceptionsData,
} from "@/lib/accounting/statements/exceptions";
import { reportPdf, reportWorkbook } from "@/lib/accounting/statements/export";
import { parseStatementParams, statementQuery } from "@/lib/accounting/statements/params";
import {
  buildProfitAndLoss,
  mergeComparison,
  type PlData,
} from "@/lib/accounting/statements/profit-loss";
import { computeRatios } from "@/lib/accounting/statements/ratios";
import {
  comparisonRange,
  formatValue,
  isWholeMonths,
  pct,
  ratio,
  yearEarlier,
} from "@/lib/accounting/statements/report";
import type { StatementAccount } from "@/lib/accounting/statements/tree";
import {
  buildVatReturn,
  vatPeriods,
  vatTotals,
  type VatData,
} from "@/lib/accounting/statements/vat";

const acc = (
  id: string,
  code: string,
  nature: StatementAccount["nature"],
  parent: string | null,
  extra: Partial<StatementAccount> = {},
): StatementAccount => ({
  id,
  code,
  name: `Name ${code}`,
  nature,
  parent_id: parent,
  is_group: !!extra.is_group,
  is_active: true,
  is_system: !!extra.is_system,
  control: null,
  allow_manual: true,
  ...extra,
});

// a small chart: the Tally groups used here and a few ledgers
const CHART: StatementAccount[] = [
  acc("g-sal", "G-SAL", "income", null, {
    is_group: true,
    is_system: true,
    affects_gross_profit: true,
  }),
  acc("g-dexp", "G-DEXP", "expense", null, {
    is_group: true,
    is_system: true,
    affects_gross_profit: true,
  }),
  acc("g-iinc", "G-IINC", "income", null, { is_group: true, is_system: true }),
  acc("g-iexp", "G-IEXP", "expense", null, { is_group: true, is_system: true }),
  acc("g-cap", "G-CAP", "equity", null, { is_group: true, is_system: true }),
  acc("g-ca", "G-CA", "asset", null, { is_group: true, is_system: true }),
  acc("g-cl", "G-CL", "liability", null, { is_group: true, is_system: true }),
  acc("g-fa", "G-FA", "asset", null, { is_group: true, is_system: true }),
  acc("g-bank", "G-BANK", "asset", "g-ca", { is_group: true, is_system: true }),
  acc("g-debt", "G-DEBT", "asset", "g-ca", { is_group: true, is_system: true }),
  acc("g-cred", "G-CRED", "liability", "g-cl", { is_group: true, is_system: true }),
  acc("g-stock", "G-STOCK", "asset", "g-ca", { is_group: true, is_system: true }),
  acc("sales", "4100", "income", "g-sal", { affects_gross_profit: true }),
  acc("cost", "5100", "expense", "g-dexp", { affects_gross_profit: true }),
  acc("other", "4900", "income", "g-iinc"),
  acc("rent", "6200", "expense", "g-iexp"),
  acc("cap", "3000", "equity", "g-cap"),
  acc("bank", "1150", "asset", "g-bank", { control: "bank" }),
  acc("deb", "1200", "asset", "g-debt", { control: "receivable" }),
  acc("cred", "2100", "liability", "g-cred", { control: "payable" }),
  acc("stock", "1300", "asset", "g-stock"),
  acc("equip", "1500", "asset", "g-fa"),
  acc("accdep", "1590", "asset", "g-fa", { cash_flow_class: "operating_noncash" }),
];

const pl = (rows: PlData["rows"], cols = ["total"]): PlData => ({
  from: "2026-07-01",
  to: "2026-09-30",
  dimension: "none",
  include_adjustment: true,
  provisional: true,
  columns: cols,
  labels: Object.fromEntries(cols.map((c) => [c, c])),
  rows,
  totals: [],
});

describe("ranges and formatting", () => {
  it("compares whole months with the months before, and other ranges by days", () => {
    expect(comparisonRange("2026-07-01", "2026-09-30", "previous")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(comparisonRange("2026-03-01", "2026-03-31", "previous")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(comparisonRange("2026-07-10", "2026-07-19", "previous")).toEqual({
      from: "2026-06-30",
      to: "2026-07-09",
    });
    expect(comparisonRange("2026-07-01", "2026-09-30", "last_year")).toEqual({
      from: "2025-07-01",
      to: "2025-09-30",
    });
    expect(comparisonRange("2028-02-01", "2028-02-29", "last_year")).toEqual({
      from: "2027-02-01",
      to: "2027-02-28",
    });
    expect(yearEarlier("2028-02-29")).toBe("2027-02-28");
    expect(isWholeMonths("2026-07-01", "2026-07-30")).toBe(false);
  });

  it("formats money, percentages and ratios; a zero denominator is not available", () => {
    expect(formatValue(-1234.5)).toBe("(1,234.50)");
    expect(formatValue(12.345, "percent")).toBe("12.3%");
    expect(formatValue(null)).toBe("");
    expect(ratio(1, 0)).toBeNull();
    expect(pct(1, 3)).toBe(33.3);
  });
});

describe("profit and loss", () => {
  it("builds the Tally layout with gross and net profit, in cents", () => {
    const d = pl([
      { account_id: "sales", col: "total", amount: 1000.1 },
      { account_id: "cost", col: "total", amount: 300.05 },
      { account_id: "other", col: "total", amount: 50 },
      { account_id: "rent", col: "total", amount: 400.02 },
    ]);
    const r = buildProfitAndLoss(CHART, d);
    expect(r.grossProfit).toEqual([700.05]);
    expect(r.netProfit).toEqual([350.03]);
    const labels = r.table.rows.map((x) => x.label);
    expect(labels.indexOf("Gross profit")).toBeLessThan(labels.indexOf("Add: indirect incomes"));
    expect(labels.at(-3)).toBe("Net profit");
    const ledger = r.table.rows.find((x) => x.code === "4100")!;
    expect(ledger.depth).toBe(2);
  });

  it("adds a Total column for dimensions and Change for a comparison", () => {
    const d = pl(
      [
        { account_id: "sales", col: "G", amount: 100 },
        { account_id: "sales", col: "", amount: 50 },
      ],
      ["", "G"],
    );
    const t = buildProfitAndLoss(CHART, d, { extra: "total" });
    expect(t.headers).toEqual(["", "G", "Total"]);
    expect(t.table.rows.find((x) => x.label === "Net profit")!.values).toEqual([50, 100, 150]);
    const cmp = mergeComparison(
      pl([{ account_id: "sales", col: "total", amount: 120 }]),
      pl([{ account_id: "sales", col: "total", amount: 100 }]),
      { cur: "This", cmp: "Last" },
    );
    const c = buildProfitAndLoss(CHART, cmp, { extra: "change" });
    expect(c.headers).toEqual(["This", "Last", "Change", "Change %"]);
    expect(c.table.rows.find((x) => x.label === "Net profit")!.values).toEqual([120, 100, 20, 20]);
    expect(c.table.rows.find((x) => x.label === "Gross margin")!.values).toEqual([
      100,
      100,
      null,
      null,
    ]);
  });

  it("shows groups only when asked, and links ledgers", () => {
    const d = pl([{ account_id: "sales", col: "total", amount: 10 }]);
    const g = buildProfitAndLoss(CHART, d, { groupsOnly: true });
    expect(g.table.rows.some((x) => x.kind === "ledger")).toBe(false);
    const l = buildProfitAndLoss(CHART, d, { hrefFor: (a) => `/l/${a.id}` });
    expect(l.table.rows.find((x) => x.code === "4100")!.href).toBe("/l/sales");
  });
});

const bs = (rows: BsData["rows"], cur = 0, earlier = 0): BsData => ({
  as_at: "2026-09-30",
  entity_id: null,
  fy_start: "2026-07-01",
  include_adjustment: true,
  provisional: false,
  rows,
  current_year_pl: cur,
  earlier_years_pl: earlier,
  totals: { assets: 0, liabilities: 0, equity: 0, difference: 0 },
});

describe("balance sheet", () => {
  it("balances with the profit lines in equity", () => {
    const r = buildBalanceSheet(CHART, [
      bs(
        [
          { account_id: "bank", nature: "asset", balance: 1200 },
          { account_id: "cap", nature: "equity", balance: 1000 },
          { account_id: "cred", nature: "liability", balance: 100 },
        ],
        80,
        20,
      ),
    ]);
    expect(r.balanced).toBe(true);
    expect(r.equity).toEqual([1100]);
    expect(r.table.rows.some((x) => x.label.startsWith("Profit for the current year"))).toBe(true);
    expect(r.table.rows.some((x) => x.flag === "warning")).toBe(false);
  });

  it("shows the difference prominently when it does not balance", () => {
    const r = buildBalanceSheet(CHART, [
      bs([{ account_id: "bank", nature: "asset", balance: 10 }]),
    ]);
    expect(r.balanced).toBe(false);
    expect(r.difference).toEqual([10]);
    expect(r.table.rows.at(-1)!.flag).toBe("warning");
  });
});

describe("cash flow", () => {
  it("classifies by own class, group defaults and control", () => {
    const m = effectiveCashFlowClasses(CHART);
    expect(m.get("bank")).toBe("cash");
    expect(m.get("deb")).toBe("working_capital");
    expect(m.get("equip")).toBe("investing");
    expect(m.get("accdep")).toBe("operating_noncash");
    expect(m.get("cap")).toBe("financing");
    expect(m.get("sales")).toBeNull();
    expect(cashFlowDefault("G-BOD", "liability", true)).toBe("cash");
    expect(cashFlowDefault("X", "asset", false)).toBeNull();
    expect(effectLabel("Receivable", "asset", -10, "working_capital")).toBe(
      "Increase in Receivable",
    );
    expect(effectLabel("Payables", "liability", 10, "working_capital")).toBe(
      "Increase in Payables",
    );
  });

  it("reconciles to the cash ledgers, or says it does not", () => {
    const data: CfData = {
      from: "2026-07-01",
      to: "2026-09-30",
      include_adjustment: true,
      provisional: true,
      net_profit: 100,
      rows: [
        { account_id: "accdep", class: "operating_noncash", amount: 20 },
        { account_id: "deb", class: "working_capital", amount: -50 },
        { account_id: "equip", class: "investing", amount: -30 },
      ],
      cash_accounts: [{ account_id: "bank", opening: 1000, closing: 1040 }],
      totals: {} as CfData["totals"],
      classes: {},
    };
    const r = buildCashFlow(CHART, data);
    expect(r.operating).toBe(70);
    expect(r.netChange).toBe(40);
    expect(r.reconciles).toBe(true);
    const off = buildCashFlow(CHART, {
      ...data,
      cash_accounts: [{ account_id: "bank", opening: 0, closing: 1 }],
    });
    expect(off.reconciles).toBe(false);
    expect(off.difference).toBe(39);
  });
});

describe("VAT return", () => {
  it("lists quarterly and monthly periods from the anchor month", () => {
    expect(vatPeriods("2026-10-13", 3, 1, 2).map((p) => [p.from, p.to])).toEqual([
      ["2026-10-01", "2026-12-31"],
      ["2026-07-01", "2026-09-30"],
    ]);
    expect(vatPeriods("2026-10-13", 3, 2, 1)[0]).toMatchObject({
      from: "2026-08-01",
      to: "2026-10-31",
    });
    expect(vatPeriods("2026-01-05", 3, 2, 1)[0]).toMatchObject({
      from: "2025-11-01",
      to: "2026-01-31",
    });
    expect(vatPeriods("2026-02-10", 1, 1, 2).map((p) => p.from)).toEqual([
      "2026-02-01",
      "2026-01-01",
    ]);
  });

  it("totals boxes 8, 11 and 12 to 14 and flags mismatches", () => {
    const box = (
      b: string,
      amount: number,
      vat: number,
      expected = vat,
      lines = 1,
      defaulted = 0,
    ) => ({
      box: b,
      amount,
      vat,
      expected_vat: expected,
      adjustment: 0,
      lines,
      defaulted_emirate: defaulted,
    });
    const data: VatData = {
      from: "2026-07-01",
      to: "2026-09-30",
      entity_id: "e",
      entity_name: "Synthetic entity",
      trn: null,
      default_emirate: "Dubai",
      provisional: true,
      boxes: [
        box("1b", 1000, 50, 50, 2, 2),
        box("3", 100, 5),
        box("4", 500, 0),
        box("9", 200, 10, 9),
        box("10", 100, 5),
      ],
      totals: {} as VatData["totals"],
      lines: [],
      lines_truncated: false,
      missing_tax_code: [],
      missing_truncated: false,
    };
    const t = vatTotals(data.boxes);
    expect(t).toEqual({
      box8_amount: 1600,
      box8_vat: 55,
      box11_amount: 300,
      box11_vat: 15,
      box12: 55,
      box13: 15,
      box14: 40,
    });
    const r = buildVatReturn(data);
    expect(r.checks.vatMismatch).toBe(true);
    expect(r.checks.defaultedLines).toBe(2);
    expect(r.tables[5].pdf).toBe(false);
  });
});

describe("budgets", () => {
  it("lists the fiscal year's months", () => {
    expect(fiscalMonths("2026-07-01")).toEqual([
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
      "2027-03",
      "2027-04",
      "2027-05",
      "2027-06",
    ]);
  });

  it("parses a CSV and reports every problem with its line", () => {
    const months = fiscalMonths("2026-07-01");
    const ok = parseBudgetCsv(
      'Account,Month,Amount,Branch,Department\n6200,2026-07,"1,000.50",G,\n4100,2026-08-01,200,,Dermatology\n',
      months,
    );
    expect(ok.errors).toEqual([]);
    expect(ok.lines).toEqual([
      {
        account_code: "6200",
        month: "2026-07",
        amount: 1000.5,
        branch_code: "G",
        department: null,
      },
      {
        account_code: "4100",
        month: "2026-08",
        amount: 200,
        branch_code: null,
        department: "Dermatology",
      },
    ]);
    const bad = parseBudgetCsv(
      "account_code,month,amount\n6200,2027-07,1\n6200,2026-07,-5\n6200,2026-07,1\n6200,2026-07,2\n",
      months,
    );
    expect(bad.errors).toEqual([
      "Line 2: the month must be yyyy-mm inside the fiscal year.",
      "Line 3: the amount must be zero or more, at most two decimals.",
      "Line 5: the same account, month, branch and department appear twice.",
    ]);
    expect(parseBudgetCsv("code;month\n", months).errors[0]).toMatch(/first row/);
    expect(parseBudgetCsv("", months).errors).toEqual(["The file is empty."]);
  });

  it("highlights expenses over and income under budget beyond the threshold", () => {
    expect(variance("expense", 1000, 1100, 10)).toEqual({ variance: 100, pct: 10, adverse: false });
    expect(variance("expense", 1000, 1100.01, 10).adverse).toBe(true);
    expect(variance("expense", 0, 1, 10).adverse).toBe(true);
    expect(variance("income", 1000, 899, 10).adverse).toBe(true);
    expect(variance("income", 1000, 2000, 10).adverse).toBe(false);
    expect(variance("income", 0, 0, 10)).toEqual({ variance: 0, pct: null, adverse: false });
    const data: BvaData = {
      budget_id: "b",
      name: "Synthetic",
      status: "approved",
      fy_start: "2026-07-01",
      entity_id: "e",
      from: "2026-07-01",
      to: "2026-07-31",
      branch: null,
      department: null,
      threshold_pct: 10,
      provisional: true,
      rows: [
        { account_id: "sales", month: "2026-07", budget: 1000, actual: 800 },
        { account_id: "rent", month: "2026-07", budget: 500, actual: 500 },
      ],
      totals: { budget_income: 1000, actual_income: 800, budget_expense: 500, actual_expense: 500 },
    };
    const r = buildBudgetVsActual(CHART, data);
    expect(r.adverseCount).toBe(1);
    expect(r.totals).toEqual({ budgetNet: 500, actualNet: 300 });
    expect(r.tables[1].rows).toHaveLength(1);
  });
});

describe("ratios", () => {
  it("work out the usual measures and leave a zero denominator out", () => {
    const r = computeRatios({
      currentAssets: 2000,
      currentLiabilities: 1000,
      stock: 500,
      receivables: 300,
      payables: 200,
      directIncome: 3000,
      totalIncome: 3650,
      totalExpense: 2400,
      grossProfit: 1200,
      netProfit: 1250,
      days: 365,
      patients: 150,
    });
    expect(r).toEqual({
      currentRatio: 2,
      quickRatio: 1.5,
      debtorDays: 30,
      creditorDays: 30.4,
      grossMarginPct: 40,
      netMarginPct: 34.2,
      workingCapital: 1000,
      revenuePerPatient: 20,
    });
    expect(
      computeRatios({
        currentAssets: 1,
        currentLiabilities: 0,
        stock: 0,
        receivables: 0,
        payables: 0,
        directIncome: 0,
        totalIncome: 0,
        totalExpense: 0,
        grossProfit: 0,
        netProfit: 0,
        days: 30,
        patients: 0,
      }),
    ).toMatchObject({
      currentRatio: null,
      debtorDays: null,
      grossMarginPct: null,
      revenuePerPatient: null,
    });
  });
});

describe("corporate tax bridge", () => {
  const settings = {
    ct_rate: 9,
    ct_threshold: 375000,
    ct_entertainment_pct: 50,
    ct_sbr_limit: 3000000,
    ct_connected_limit: 500000,
  };
  const data = (profit: number, revenue: number, by: CtData["by_treatment"]): CtData => ({
    from: "2026-07-01",
    to: "2027-06-30",
    provisional: true,
    settings,
    accounting_profit: profit,
    revenue,
    by_treatment: by,
    accounts: [],
  });

  it("adds back the non-deductible part and taxes above the 0% band", () => {
    const b = ctBridge(
      data(1_000_000, 8_000_000, {
        entertainment: 20_000,
        fines_penalties: 5_000,
        donations: 1_000,
      }),
      {
        otherAddBacks: 4_000,
        otherDeductions: 10_000,
      },
    );
    expect(b.addBacks).toBe(10_000 + 5_000 + 1_000 + 4_000);
    expect(b.taxableIncome).toBe(1_010_000);
    expect(b.taxable).toBe(635_000);
    expect(b.tax).toBe(57_150);
    expect(b.sbrMayApply).toBe(false);
  });

  it("notes Small Business Relief and connected-person payments, never deciding them", () => {
    const b = ctBridge(data(100_000, 2_000_000, { connected_person: 600_000 }), {
      otherAddBacks: 0,
      otherDeductions: 0,
    });
    expect(b.tax).toBe(0);
    expect(b.sbrMayApply).toBe(true);
    expect(b.connectedOverLimit).toBe(true);
    expect(b.notes[0]).toMatch(/Working paper, not a tax return/);
    expect(b.notes.join(" ")).toMatch(/transfer pricing disclosure/);
  });
});

describe("exceptions", () => {
  it("shape each list and count them", () => {
    const d: ExceptionsData = {
      from: "2026-07-01",
      to: "2026-09-30",
      large_journal_amount: 1000,
      provisional: true,
      late_postings: [],
      negative_cash: [
        { account_id: "bank", code: "1150", name: "Bank", date: "2026-09-20", balance: -75 },
      ],
      opposite_balances: [
        { account_id: "accdep", code: "1590", name: "Acc dep", nature: "asset", balance: -500 },
      ],
      suspense: [],
      large_manual: [],
      missing_dimension: [],
    };
    const t = buildExceptions(d, { ledgerHref: (id) => `/l/${id}` });
    expect(t).toHaveLength(6);
    expect(exceptionCount(d)).toBe(2);
    expect(t[1].rows[0].href).toBe("/l/bank");
    expect(t[2].rows[0].values).toEqual(["Asset", -500]);
  });
});

describe("query options", () => {
  it("fall back to the default range and keep only known values", () => {
    const p = parseStatementParams(
      {
        from: "2026-09-30",
        to: "2026-07-01",
        dim: "patient",
        compare: "x",
        box: "1b",
        add: "1,000.5",
        ded: "-3",
      },
      { from: "2026-07-01", to: "2026-10-13" },
    );
    expect(p).toMatchObject({
      from: "2026-07-01",
      to: "2026-10-13",
      dimension: "none",
      compare: "none",
      box: "1b",
      otherAddBacks: 1000.5,
      otherDeductions: 0,
    });
    expect(p.problem).toMatch(/start date/);
    const q = parseStatementParams(
      new URLSearchParams("from=2026-07-01&to=2026-07-31&adj=0&dim=branch"),
      {
        from: "x",
        to: "y",
      },
    );
    expect(statementQuery(q)).toBe("from=2026-07-01&to=2026-07-31&adj=0&dim=branch");
  });
});

describe("exports", () => {
  const doc = {
    title: "Profit and loss",
    subtitle: "1 Jul 2026 to 30 Sep 2026.",
    provisional: true,
    workingPaper: null,
    warnings: [],
    notes: ["A note."],
    tables: [
      {
        columns: ["Amount", "Margin"],
        formats: ["money" as const, "percent" as const],
        rows: [
          { label: "Sales", code: "4100", depth: 1, kind: "ledger" as const, values: [100, 12.5] },
          {
            label: "Net profit",
            depth: 0,
            kind: "total" as const,
            values: [100, null],
            flag: "warning" as const,
          },
        ],
      },
    ],
  };
  const meta = { org: "Synthetic Clinic", builtAt: "2026-10-13T10:00:00.000Z" };

  it("writes a workbook with the Provisional label and plain values", async () => {
    const buf = await reportWorkbook(doc, meta);
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const texts: string[] = [];
    ws.eachRow((r) => texts.push(String(r.getCell(1).value ?? "")));
    expect(texts.some((t) => t.startsWith("PROVISIONAL"))).toBe(true);
    let found = false;
    ws.eachRow((r) => {
      if (r.getCell(1).value === "4100") {
        expect(r.getCell(3).value).toBe(100);
        expect(r.getCell(4).value).toBe(0.125);
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it("writes a PDF", async () => {
    const buf = await reportPdf(doc, meta);
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
