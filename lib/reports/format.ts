/** Display formatting for report values. Fixed locale so server and client render identically. */

const NUMBER = new Intl.NumberFormat("en-US");

export function formatNumber(n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? "—" : NUMBER.format(Math.round(n * 100) / 100);
}

export function formatPercent(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? "—" : `${NUMBER.format(Math.round(ratio * 1000) / 10)}%`;
}

/** Seconds → "45s", "4m 12s", "2h 05m", "3d 4h". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export type ValueFormat = "number" | "duration" | "percent" | "text";

export function formatValue(value: unknown, format: ValueFormat = "text"): string {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "text") return String(value);
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  return format === "duration" ? formatDuration(n) : format === "percent" ? formatPercent(n) : formatNumber(n);
}
