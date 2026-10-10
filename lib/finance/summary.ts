/** Pure helpers for the Monthly summary screen. The numbers themselves come from the SQL views. */

export type SummaryRow = {
  month: string;
  branch_code: string | null;
  generated: number | null;
  claimed: number | null;
  remitted: number | null;
  rejected: number | null;
  outstanding: number | null;
  self_pay_collected: number | null;
};

export const SUMMARY_COLUMNS = [
  "generated",
  "claimed",
  "remitted",
  "rejected",
  "outstanding",
  "self_pay_collected",
] as const;
export type SummaryColumn = (typeof SUMMARY_COLUMNS)[number];

export function totals(rows: readonly SummaryRow[]): Record<SummaryColumn, number> {
  const out = Object.fromEntries(SUMMARY_COLUMNS.map((c) => [c, 0])) as Record<
    SummaryColumn,
    number
  >;
  for (const r of rows) for (const c of SUMMARY_COLUMNS) out[c] += Number(r[c] ?? 0);
  for (const c of SUMMARY_COLUMNS) out[c] = Math.round(out[c] * 100) / 100;
  return out;
}

/** yyyy-mm (validated) or the fallback. */
export function monthParam(v: string | undefined, fallback: string): string {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v ?? "") ? (v as string) : fallback;
}

export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function monthsAgo(n: number, now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1));
  return d.toISOString().slice(0, 7);
}

export type RevenueRow = {
  branch_code: string | null;
  department: string | null;
  doctor_name: string | null;
  doctor_dha_id: string | null;
  service_category: string | null;
  gross: number | null;
  discount: number | null;
  net: number | null;
  vat: number | null;
};

export type RevenueGroup = "department" | "doctor" | "service_category" | "branch";
export const REVENUE_GROUPS: ReadonlyArray<{ key: RevenueGroup; label: string }> = [
  { key: "department", label: "Department" },
  { key: "doctor", label: "Doctor" },
  { key: "service_category", label: "Service category" },
  { key: "branch", label: "Branch" },
];

export function groupLabel(row: RevenueRow, group: RevenueGroup): string {
  switch (group) {
    case "department":
      return row.department?.trim() || "No department";
    case "doctor":
      return row.doctor_name?.trim() || row.doctor_dha_id?.trim() || "Unknown doctor";
    case "service_category":
      return row.service_category?.trim() || "Unmapped";
    default:
      return row.branch_code?.trim() || "Unknown branch";
  }
}

export function groupRevenue(rows: readonly RevenueRow[], group: RevenueGroup) {
  const map = new Map<
    string,
    { label: string; gross: number; discount: number; net: number; vat: number }
  >();
  for (const r of rows) {
    const label = groupLabel(r, group);
    const g = map.get(label) ?? { label, gross: 0, discount: 0, net: 0, vat: 0 };
    g.gross += Number(r.gross ?? 0);
    g.discount += Number(r.discount ?? 0);
    g.net += Number(r.net ?? 0);
    g.vat += Number(r.vat ?? 0);
    map.set(label, g);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return [...map.values()]
    .map((g) => ({
      ...g,
      gross: r2(g.gross),
      discount: r2(g.discount),
      net: r2(g.net),
      vat: r2(g.vat),
    }))
    .sort((a, b) => b.net - a.net || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Range presets and period-over-period comparison (UTC month arithmetic)
// ---------------------------------------------------------------------------

export type RangeKey = "this_month" | "last_month" | "last_3" | "ytd" | "last_12";
export const RANGE_PRESETS: ReadonlyArray<{ key: RangeKey; label: string }> = [
  { key: "this_month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "last_3", label: "Last 3 months" },
  { key: "ytd", label: "Year to date" },
  { key: "last_12", label: "Last 12 months" },
];

export function rangeFor(key: RangeKey, now = new Date()): { from: string; to: string } {
  const cur = currentMonth(now);
  switch (key) {
    case "this_month":
      return { from: cur, to: cur };
    case "last_month":
      return { from: monthsAgo(1, now), to: monthsAgo(1, now) };
    case "last_3":
      return { from: monthsAgo(2, now), to: cur };
    case "ytd":
      return { from: `${cur.slice(0, 4)}-01`, to: cur };
    default:
      return { from: monthsAgo(11, now), to: cur };
  }
}

/** The preset whose range equals from/to, if any (to highlight the active chip). */
export function activeRange(from: string, to: string, now = new Date()): RangeKey | null {
  for (const p of RANGE_PRESETS) {
    const r = rangeFor(p.key, now);
    if (r.from === from && r.to === to) return p.key;
  }
  return null;
}

/** Number of calendar months from..to inclusive (0 when to is before from). */
export function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return Math.max(0, (ty - fy) * 12 + (tm - fm) + 1);
}

function shiftMonth(ym: string, by: number): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + by, 1)).toISOString().slice(0, 7);
}

/** The range of equal length directly before from..to. */
export function previousRange(from: string, to: string): { from: string; to: string } {
  const n = Math.max(1, monthSpan(from, to));
  return { from: shiftMonth(from, -n), to: shiftMonth(from, -1) };
}

/** Splits rows fetched over (previous + current) into the two periods by month. */
export function splitPeriods<T extends { month: string }>(
  rows: readonly T[],
  from: string,
): { current: T[]; previous: T[] } {
  const cut = `${from}-01`;
  return {
    current: rows.filter((r) => r.month >= cut),
    previous: rows.filter((r) => r.month < cut),
  };
}

/** Per-month totals (all branches), oldest first, for the trend chart. */
export function monthlySeries(
  rows: readonly SummaryRow[],
): Array<{ month: string } & Record<SummaryColumn, number>> {
  const by = new Map<string, SummaryRow[]>();
  for (const r of rows) by.set(r.month.slice(0, 7), [...(by.get(r.month.slice(0, 7)) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, rs]) => ({ month, ...totals(rs) }));
}
