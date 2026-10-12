import { addDays, dayNumber } from "@/lib/documents/expiry";

/** Revenue views (pure): parsing, shares, comparison with the previous period, and a safe CSV. */

export const REVENUE_DIMENSIONS = [
  "doctor",
  "department",
  "branch",
  "service",
  "category",
  "month",
] as const;
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<RevenueDimension, string> = {
  doctor: "Doctor",
  department: "Department",
  branch: "Branch",
  service: "Service",
  category: "Service category",
  month: "Month",
};

export type RevenueRow = {
  key: string;
  label: string | null;
  net: number;
  gross: number;
  discount: number;
  vat: number;
  lines: number;
  invoices: number;
};

export type RevenueRowWithShare = RevenueRow & {
  share: number;
  previousNet: number | null;
  changePct: number | null;
};

export function parseRevenue(json: unknown): RevenueRow[] {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      key: String(o.key ?? ""),
      label: o.label == null ? null : String(o.label),
      net: Number(o.net ?? 0),
      gross: Number(o.gross ?? 0),
      discount: Number(o.discount ?? 0),
      vat: Number(o.vat ?? 0),
      lines: Number(o.lines ?? 0),
      invoices: Number(o.invoices ?? 0),
    };
  });
}

export function withComparison(
  current: readonly RevenueRow[],
  previous: readonly RevenueRow[] | null,
): RevenueRowWithShare[] {
  const total = current.reduce((a, r) => a + r.net, 0);
  const prev = new Map((previous ?? []).map((r) => [r.key, r.net]));
  return current.map((r) => {
    const p = previous ? (prev.get(r.key) ?? 0) : null;
    return {
      ...r,
      share: total > 0 ? r.net / total : 0,
      previousNet: p,
      changePct: p !== null && p > 0 ? Math.round(((r.net - p) / p) * 1000) / 10 : null,
    };
  });
}

/** The period of equal length that ends the day before `from`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } | null {
  const f = dayNumber(from);
  const t = dayNumber(to);
  if (f === null || t === null || t < f) return null;
  const len = t - f + 1;
  const pTo = addDays(from, -1);
  const pFrom = pTo ? addDays(pTo, -(len - 1)) : null;
  return pFrom && pTo ? { from: pFrom, to: pTo } : null;
}

const csvText = (s: string) => {
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function revenueCsv(
  rows: readonly RevenueRowWithShare[],
  dimension: RevenueDimension,
): string {
  const head = [
    DIMENSION_LABELS[dimension],
    "Name",
    "Net",
    "Gross",
    "Discount",
    "VAT",
    "Invoices",
    "Lines",
    "Share of net",
    "Previous net",
    "Change %",
  ];
  const body = rows.map((r) =>
    [
      csvText(r.key),
      csvText(r.label ?? ""),
      r.net.toFixed(2),
      r.gross.toFixed(2),
      r.discount.toFixed(2),
      r.vat.toFixed(2),
      String(r.invoices),
      String(r.lines),
      (r.share * 100).toFixed(1),
      r.previousNet === null ? "" : r.previousNet.toFixed(2),
      r.changePct === null ? "" : String(r.changePct),
    ].join(","),
  );
  return [head.join(","), ...body].join("\r\n") + "\r\n";
}
