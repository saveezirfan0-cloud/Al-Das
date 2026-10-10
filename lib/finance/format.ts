/** Display helpers shared by every finance screen. Amounts are AED. */

const NBSP = " ";

/** 1,234.50 (two decimals, grouping); "—" for null / undefined / NaN. */
export function money(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Compact for KPI cards: 1.2M, 34.5K, 980. Full precision stays in the tables. */
export function moneyCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return money(n);
}

export const aed = (n: number | string | null | undefined) => {
  const m = money(n);
  return m === "—" ? m : `AED${NBSP}${m}`;
};

export type Delta = { pct: number | null; direction: "up" | "down" | "flat" | "none" };

/**
 * Change from `previous` to `current`. With no usable previous value (zero,
 * missing) the percentage is null rather than a misleading "+Infinity%".
 */
export function delta(current: number, previous: number | null | undefined): Delta {
  if (previous === null || previous === undefined || !Number.isFinite(previous) || previous === 0) {
    return { pct: null, direction: "none" };
  }
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return { pct, direction: pct > 0 ? "up" : pct < 0 ? "down" : "flat" };
}

export function deltaLabel(d: Delta): string {
  if (d.pct === null) return "no earlier period to compare";
  if (d.direction === "flat") return "unchanged vs earlier period";
  return `${d.pct > 0 ? "+" : ""}${d.pct}% vs earlier period`;
}

/** "3 h ago", "2 days ago"; used for the "data as of" line. */
export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "never";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
