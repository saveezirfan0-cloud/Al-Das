/**
 * Contribution margin and estimated profitability (Integration Blueprint v2, p4). Pure: it takes the rows the database
 * returned and the cost inputs Finance maintains, and never reads a table.
 *
 *   contribution margin     = revenue - direct service cost - attributable doctor compensation
 *   estimated profitability = contribution margin - allocated operating (overhead) cost
 *
 * Honesty rules:
 *   - a service line with no Finance cost is UNCOSTED, never free: coverage shows how much revenue is costed;
 *   - a figure is PROVISIONAL until every month it covers is approved by Finance AND its costs are complete;
 *   - with no cost inputs at all the margin is null, not equal to revenue;
 *   - overhead is only allocated at branch and month level (it is not invented at doctor or department level).
 */

export type ProfitInputRow = {
  month: string; // yyyy-mm-dd, first of the month
  branch_code: string | null;
  department: string | null;
  doctor_dha_id: string | null;
  revenue_net: number;
  direct_cost: number;
  costed_net: number;
  lines: number;
  uncosted_lines: number;
};
export type CompRow = { month: string; doctor_dha_id: string; amount: number };
export type OverheadRow = {
  month: string;
  branch_code: string | null;
  pool: string;
  amount: number;
  basis: "revenue" | "invoices" | "equal";
};

export type ProfitGroupBy = "month" | "branch" | "doctor" | "department";

export type ProfitLine = {
  key: string;
  revenue: number;
  directCost: number;
  /** share of revenue that has a Finance cost, 0..1 (null when there is no revenue) */
  coverage: number | null;
  doctorComp: number | null;
  contributionMargin: number | null;
  overhead: number | null;
  estimatedProfit: number | null;
  /** why the figure cannot be treated as final */
  provisional: string[];
};

export type ProfitResult = {
  rows: ProfitLine[];
  totals: ProfitLine;
  provisional: boolean;
  reasons: string[];
};

export type ProfitInput = {
  rows: readonly ProfitInputRow[];
  /** null = the viewer may not see doctor compensation (it is then not included and the result says so) */
  comp: readonly CompRow[] | null;
  overheads: readonly OverheadRow[];
  /** months (yyyy-mm-dd, first of month) that Finance has approved */
  approvedMonths: readonly string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (n: unknown) => (Number.isFinite(Number(n)) ? Number(n) : 0);

type Cell = { month: string; branch: string; revenue: number; lines: number };

/** Overhead allocated to each (month, branch) cell. Shared pools are split by the pool's basis. */
export function allocateOverheads(
  rows: readonly ProfitInputRow[],
  overheads: readonly OverheadRow[],
): { byCell: Map<string, number>; unallocated: number } {
  const cells = new Map<string, Cell>();
  for (const r of rows) {
    const branch = r.branch_code ?? "";
    const k = `${r.month}|${branch}`;
    const c = cells.get(k) ?? { month: r.month, branch, revenue: 0, lines: 0 };
    c.revenue += num(r.revenue_net);
    c.lines += num(r.lines);
    cells.set(k, c);
  }
  const byCell = new Map<string, number>();
  let unallocated = 0;
  const add = (k: string, v: number) => byCell.set(k, (byCell.get(k) ?? 0) + v);

  for (const o of overheads) {
    const amount = num(o.amount);
    if (o.branch_code) {
      const k = `${o.month}|${o.branch_code}`;
      if (cells.has(k)) add(k, amount);
      else unallocated += amount; // a branch with no revenue that month: nothing to attach it to
      continue;
    }
    const month = [...cells.values()].filter((c) => c.month === o.month);
    if (month.length === 0) {
      unallocated += amount;
      continue;
    }
    const weights = month.map((c) =>
      o.basis === "invoices" ? c.lines : o.basis === "equal" ? 1 : Math.max(c.revenue, 0),
    );
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      unallocated += amount;
      continue;
    }
    month.forEach((c, i) => add(`${c.month}|${c.branch}`, (amount * weights[i]) / total));
  }
  return { byCell, unallocated: r2(unallocated) };
}

export function computeProfitability(input: ProfitInput, groupBy: ProfitGroupBy): ProfitResult {
  const approved = new Set(input.approvedMonths);
  const reasons = new Set<string>();

  // doctor compensation attributed to the doctor's branches in proportion to that doctor's revenue that month
  const compCell = new Map<string, number>(); // month|branch -> comp
  const compDoctor = new Map<string, number>(); // doctor|month|branch -> comp
  if (input.comp) {
    const revenueByDocMonth = new Map<string, Map<string, number>>();
    for (const r of input.rows) {
      if (!r.doctor_dha_id) continue;
      const k = `${r.doctor_dha_id}|${r.month}`;
      const m = revenueByDocMonth.get(k) ?? new Map<string, number>();
      m.set(
        r.branch_code ?? "",
        (m.get(r.branch_code ?? "") ?? 0) + Math.max(num(r.revenue_net), 0),
      );
      revenueByDocMonth.set(k, m);
    }
    for (const c of input.comp) {
      const m = revenueByDocMonth.get(`${c.doctor_dha_id}|${c.month}`);
      if (!m) {
        reasons.add(
          "Some doctor compensation belongs to doctors with no revenue in the range and is left out.",
        );
        continue;
      }
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      for (const [branch, rev] of m) {
        const share = total > 0 ? rev / total : 1 / m.size;
        const part = num(c.amount) * share;
        compCell.set(`${c.month}|${branch}`, (compCell.get(`${c.month}|${branch}`) ?? 0) + part);
        const dk = `${c.doctor_dha_id}|${c.month}|${branch}`;
        compDoctor.set(dk, (compDoctor.get(dk) ?? 0) + part);
      }
    }
  } else {
    reasons.add("Doctor compensation is not visible to you and is not included.");
  }

  const { byCell: overheadCell, unallocated } = allocateOverheads(input.rows, input.overheads);
  if (unallocated > 0)
    reasons.add(
      `${unallocated.toFixed(2)} of overhead could not be attached to any branch and month.`,
    );

  const keyOf = (r: ProfitInputRow): string =>
    groupBy === "month"
      ? r.month.slice(0, 7)
      : groupBy === "branch"
        ? (r.branch_code ?? "Unknown branch")
        : groupBy === "doctor"
          ? (r.doctor_dha_id ?? "No doctor")
          : (r.department ?? "No department");

  type Acc = {
    revenue: number;
    direct: number;
    costed: number;
    comp: number;
    overhead: number;
    months: Set<string>;
    cells: Set<string>;
  };
  const acc = new Map<string, Acc>();
  const grab = (key: string): Acc => {
    const a = acc.get(key) ?? {
      revenue: 0,
      direct: 0,
      costed: 0,
      comp: 0,
      overhead: 0,
      months: new Set(),
      cells: new Set(),
    };
    acc.set(key, a);
    return a;
  };
  for (const r of input.rows) {
    const a = grab(keyOf(r));
    a.revenue += num(r.revenue_net);
    a.direct += num(r.direct_cost);
    a.costed += num(r.costed_net);
    a.months.add(r.month);
    a.cells.add(`${r.month}|${r.branch_code ?? ""}`);
  }
  // comp and overhead are attached once per (month, branch) cell, to the group that owns that cell
  if (groupBy === "doctor") {
    for (const [dk, v] of compDoctor) {
      const [doctor] = dk.split("|");
      if (acc.has(doctor)) grab(doctor).comp += v;
    }
  } else {
    const seen = new Set<string>();
    for (const r of input.rows) {
      const cell = `${r.month}|${r.branch_code ?? ""}`;
      const owner = keyOf(r);
      const once = `${owner}#${cell}`;
      if (seen.has(once)) continue;
      seen.add(once);
      if (groupBy === "branch" || groupBy === "month") {
        grab(owner).comp += compCell.get(cell) ?? 0;
        grab(owner).overhead += overheadCell.get(cell) ?? 0;
      } else if (groupBy === "department") {
        // compensation by department is not apportioned; shown only at branch, month and doctor level
      }
    }
  }

  const noCosts =
    input.rows.every((r) => num(r.costed_net) === 0) &&
    (input.comp?.length ?? 0) === 0 &&
    input.overheads.length === 0;
  if (noCosts) reasons.add("No cost inputs have been loaded yet, so no margin is shown.");

  const build = (key: string, a: Acc): ProfitLine => {
    const coverage = a.revenue > 0 ? Math.min(1, a.costed / a.revenue) : null;
    const prov: string[] = [];
    if ([...a.months].some((m) => !approved.has(m))) prov.push("Month not approved by Finance");
    if (coverage !== null && coverage < 1)
      prov.push(`${Math.round(coverage * 100)}% of revenue has a service cost`);
    const hasAny = a.direct > 0 || a.comp > 0 || a.overhead > 0;
    const margin = hasAny ? r2(a.revenue - a.direct - (input.comp ? a.comp : 0)) : null;
    const showOverhead = groupBy === "branch" || groupBy === "month";
    return {
      key,
      revenue: r2(a.revenue),
      directCost: r2(a.direct),
      coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000,
      doctorComp: input.comp ? r2(a.comp) : null,
      contributionMargin: margin,
      overhead: showOverhead ? r2(a.overhead) : null,
      estimatedProfit: margin !== null && showOverhead ? r2(margin - a.overhead) : null,
      provisional: prov,
    };
  };

  const rows = [...acc.entries()]
    .map(([k, a]) => build(k, a))
    .sort((a, b) => b.revenue - a.revenue || a.key.localeCompare(b.key));

  const total: Acc = {
    revenue: 0,
    direct: 0,
    costed: 0,
    comp: 0,
    overhead: 0,
    months: new Set(),
    cells: new Set(),
  };
  for (const a of acc.values()) {
    total.revenue += a.revenue;
    total.direct += a.direct;
    total.costed += a.costed;
    total.comp += a.comp;
    total.overhead += a.overhead;
    a.months.forEach((m) => total.months.add(m));
  }
  const totals = build("Total", total);
  const provisional = totals.provisional.length > 0 || noCosts || input.rows.length === 0;
  if (totals.provisional.length > 0) totals.provisional.forEach((p) => reasons.add(p));
  return { rows, totals, provisional, reasons: [...reasons] };
}

export const PROVISIONAL_LABEL = "Provisional";
