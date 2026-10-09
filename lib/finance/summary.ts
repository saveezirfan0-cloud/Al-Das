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
