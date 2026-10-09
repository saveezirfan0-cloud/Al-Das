/** Series colors follow the entity's slot, never its rank. Slots are CSS variables so dark mode swaps in one place. */
export const SERIES_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)", "var(--viz-7)", "var(--viz-8)"] as const;

export function seriesColor(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}

/** "2026-01-11" → "Jan 11". Fixed locale + UTC so server and client render the same text. */
export function shortDay(ymd: unknown): string {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return String(ymd ?? "");
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export const AXIS_TICK = { fill: "var(--muted-foreground)", fontSize: 11 } as const;
