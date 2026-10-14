import {
  cents,
  fromCents,
  monthLabel,
  pct,
  type ReportRow,
  type ReportTable,
} from "@/lib/accounting/statements/report";
import type { StatementAccount } from "@/lib/accounting/statements/tree";

/**
 * Budgets (pure): the CSV import, the twelve months of a fiscal year, and budget against actual with the variance, the
 * percentage and the highlight. A line is adverse when an expense is more than the threshold percent over budget (or
 * has no budget at all) or an income is more than the threshold percent under budget. The threshold comes from
 * Settings (fin_ref_finance_settings.acc_budget_variance_pct), returned by acc_budget_vs_actual.
 */

export type BudgetLineInput = {
  account_code: string;
  month: string; // yyyy-mm
  branch_code: string | null;
  department: string | null;
  amount: number;
};

/** The twelve months (yyyy-mm) of the fiscal year starting on fyStart. */
export function fiscalMonths(fyStart: string): string[] {
  const y = Number(fyStart.slice(0, 4));
  const m = Number(fyStart.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const t = y * 12 + m + i;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
  });
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const HEADER_ALIASES: Record<string, keyof BudgetLineInput> = {
  account: "account_code",
  account_code: "account_code",
  code: "account_code",
  month: "month",
  period: "month",
  amount: "amount",
  budget: "amount",
  branch: "branch_code",
  branch_code: "branch_code",
  department: "department",
  dept: "department",
};

/**
 * A budget CSV: a header row naming at least account_code, month (yyyy-mm) and amount; branch_code and department are
 * optional. Amounts may carry thousands separators. Only the named columns are read. At most 20,000 lines. Every
 * problem is returned with its line number; nothing is guessed.
 */
export function parseBudgetCsv(
  text: string,
  months: readonly string[],
): { lines: BudgetLineInput[]; errors: string[] } {
  const raw = text.replace(/^﻿/, "").split(/\r?\n/);
  const errors: string[] = [];
  const lines: BudgetLineInput[] = [];
  const headerIdx = raw.findIndex((l) => l.trim() !== "");
  if (headerIdx < 0) return { lines, errors: ["The file is empty."] };
  const head = splitCsvLine(raw[headerIdx]).map(
    (h) => HEADER_ALIASES[h.toLowerCase().replace(/\s+/g, "_")],
  );
  const col = (k: keyof BudgetLineInput) => head.indexOf(k);
  if (col("account_code") < 0 || col("month") < 0 || col("amount") < 0)
    return {
      lines,
      errors: ["The first row must name the columns account_code, month and amount."],
    };
  const allowed = new Set(months);
  const seen = new Set<string>();
  for (let i = headerIdx + 1; i < raw.length; i++) {
    if (raw[i].trim() === "") continue;
    const n = i + 1;
    if (lines.length >= 20000) {
      errors.push("At most 20,000 lines.");
      break;
    }
    const cells = splitCsvLine(raw[i]);
    const get = (k: keyof BudgetLineInput) => (col(k) >= 0 ? (cells[col(k)] ?? "") : "");
    const code = get("account_code").toUpperCase();
    const monthRaw = get("month");
    const mm = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(monthRaw);
    const month = mm ? `${mm[1]}-${mm[2]}` : "";
    const amountText = get("amount").replace(/,/g, "");
    const amount = /^\d+(\.\d{1,2})?$/.test(amountText) ? Number(amountText) : Number.NaN;
    const branch = get("branch_code") || null;
    const department = get("department") || null;
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(code))
      errors.push(`Line ${n}: the account code is not valid.`);
    else if (!allowed.has(month))
      errors.push(`Line ${n}: the month must be yyyy-mm inside the fiscal year.`);
    else if (!Number.isFinite(amount))
      errors.push(`Line ${n}: the amount must be zero or more, at most two decimals.`);
    else if (department && department.length > 60)
      errors.push(`Line ${n}: the department is too long.`);
    else {
      const key = `${code}|${month}|${branch ?? ""}|${department ?? ""}`;
      if (seen.has(key))
        errors.push(`Line ${n}: the same account, month, branch and department appear twice.`);
      else {
        seen.add(key);
        lines.push({ account_code: code, month, branch_code: branch, department, amount });
      }
    }
  }
  if (lines.length === 0 && errors.length === 0) errors.push("The file has no lines.");
  return { lines, errors };
}

export type BvaData = {
  budget_id: string;
  name: string;
  status: "draft" | "approved";
  fy_start: string;
  entity_id: string;
  from: string;
  to: string;
  branch: string | null;
  department: string | null;
  threshold_pct: number;
  provisional: boolean;
  rows: Array<{ account_id: string; month: string; budget: number; actual: number }>;
  totals: {
    budget_income: number;
    actual_income: number;
    budget_expense: number;
    actual_expense: number;
  };
};

/** Variance (actual - budget), its percent of budget, and whether it is adverse beyond the threshold. */
export function variance(
  nature: "income" | "expense",
  budget: number,
  actual: number,
  thresholdPct: number,
): { variance: number; pct: number | null; adverse: boolean } {
  const b = cents(budget);
  const a = cents(actual);
  const v = a - b;
  const limit = Math.round((Math.abs(b) * thresholdPct) / 100);
  const adverse =
    nature === "expense" ? (b === 0 ? a > 0 : v > limit) : b === 0 ? false : -v > limit;
  return { variance: fromCents(v), pct: pct(v, Math.abs(b)), adverse };
}

export type BudgetVsActual = {
  tables: ReportTable[];
  adverseCount: number;
  totals: { budgetNet: number; actualNet: number };
};

export function buildBudgetVsActual(
  accounts: readonly StatementAccount[],
  data: BvaData,
  opts: { hrefFor?: (a: StatementAccount) => string | null } = {},
): BudgetVsActual {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const per = new Map<string, { b: number; a: number }>();
  for (const r of data.rows) {
    const s = per.get(r.account_id) ?? { b: 0, a: 0 };
    s.b += cents(r.budget);
    s.a += cents(r.actual);
    per.set(r.account_id, s);
  }
  let adverseCount = 0;
  const section = (nature: "income" | "expense", title: string) => {
    const ids = [...per.keys()]
      .filter((id) => byId.get(id)?.nature === nature)
      .sort((x, y) => ((byId.get(x)?.code ?? "") < (byId.get(y)?.code ?? "") ? -1 : 1));
    let tb = 0;
    let ta = 0;
    const rows: ReportRow[] = ids.map((id) => {
      const s = per.get(id)!;
      tb += s.b;
      ta += s.a;
      const v = variance(nature, fromCents(s.b), fromCents(s.a), data.threshold_pct);
      if (v.adverse) adverseCount++;
      const acc = byId.get(id)!;
      return {
        label: acc.name,
        code: acc.code,
        depth: 1,
        kind: "ledger",
        values: [fromCents(s.b), fromCents(s.a), v.variance, v.pct],
        href: opts.hrefFor ? opts.hrefFor(acc) : null,
        flag: v.adverse ? "adverse" : null,
      };
    });
    const v = variance(nature, fromCents(tb), fromCents(ta), data.threshold_pct);
    return {
      tb,
      ta,
      rows: [
        { label: title, depth: 0, kind: "heading", values: [] } as ReportRow,
        ...rows,
        {
          label: `Total ${title.toLowerCase()}`,
          depth: 0,
          kind: "subtotal",
          values: [fromCents(tb), fromCents(ta), v.variance, v.pct],
          flag: v.adverse ? "adverse" : null,
        } as ReportRow,
      ],
    };
  };
  const inc = section("income", "Income");
  const exp = section("expense", "Expenses");
  const bn = inc.tb - exp.tb;
  const an = inc.ta - exp.ta;
  const formats = ["money", "money", "money", "percent"] as const;
  const main: ReportTable = {
    labelHeader: "Account",
    columns: ["Budget", "Actual", "Variance", "Variance %"],
    formats: [...formats],
    rows: [
      ...inc.rows,
      ...exp.rows,
      {
        label: "Net profit",
        depth: 0,
        kind: "total",
        values: [fromCents(bn), fromCents(an), fromCents(an - bn), pct(an - bn, Math.abs(bn))],
      },
    ],
    empty: "No budget lines or actuals in this range.",
  };
  // per month: income and expense, budget against actual
  const months = new Map<string, { bi: number; ai: number; be: number; ae: number }>();
  for (const r of data.rows) {
    const n = byId.get(r.account_id)?.nature;
    const m = months.get(r.month) ?? { bi: 0, ai: 0, be: 0, ae: 0 };
    if (n === "income") {
      m.bi += cents(r.budget);
      m.ai += cents(r.actual);
    } else if (n === "expense") {
      m.be += cents(r.budget);
      m.ae += cents(r.actual);
    }
    months.set(r.month, m);
  }
  const monthly: ReportTable = {
    title: "By month",
    labelHeader: "Month",
    columns: [
      "Income budget",
      "Income actual",
      "Expense budget",
      "Expense actual",
      "Net budget",
      "Net actual",
    ],
    rows: [...months.keys()].sort().map((k) => {
      const m = months.get(k)!;
      return {
        label: monthLabel(k),
        depth: 0,
        kind: "ledger",
        values: [m.bi, m.ai, m.be, m.ae, m.bi - m.be, m.ai - m.ae].map(fromCents),
      };
    }),
  };
  return {
    tables: [main, monthly],
    adverseCount,
    totals: { budgetNet: fromCents(bn), actualNet: fromCents(an) },
  };
}
