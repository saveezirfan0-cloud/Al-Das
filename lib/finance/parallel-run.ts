import { shiftMonth } from "@/lib/finance/report-emails";

/**
 * Parallel run (W4, pure): Pulse's figure for a month beside the manual figure Finance produces today, the difference,
 * and whether an area may be marked "switched". Amounts are AED with three decimals (the neighbours' numeric(14,3)); the
 * comparison is done in whole fils so 0.1 + 0.2 never decides anything. "Agrees" means the difference is within the
 * tolerance, which is a column of fin_ref_finance_settings (parallel_tolerance), never a constant here.
 */

export const AREAS = ["revenue", "collections", "bank", "insurance", "labs"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LABEL: Record<Area, string> = {
  revenue: "Revenue",
  collections: "Collections",
  bank: "Bank",
  insurance: "Insurance receivable",
  labs: "Labs",
};

/** The area's own report key: a member sees an area only with it (the same rule as the reports hub). */
export const AREA_VIEW_KEY: Record<Area, string> = {
  revenue: "finance.revenue.view",
  collections: "finance.revenue.view",
  bank: "finance.bank.view",
  insurance: "finance.claims.view",
  labs: "finance.labs.view",
};

/** What Pulse's figure is, in words, so the manual figure is typed on the same basis. */
export const AREA_BASIS: Record<Area, string> = {
  revenue:
    "Net revenue of current invoice lines for invoices dated in the month (the close pack's revenue).",
  collections:
    "All payments received dated in the month, before refunds (the close pack's collected).",
  bank: "Bank lines matched to expected receipts in reviewed or signed bank reconciliations for the month, all accounts.",
  insurance:
    "Outstanding on claims whose transaction month is the month, as of today (the close pack's outstanding).",
  labs: "Total lab and referral cost in reviewed or posted provider statements for the month.",
};

export const isArea = (v: unknown): v is Area => (AREAS as readonly string[]).includes(v as string);

/** Whole fils (thousandths of a dirham). */
export const fils = (n: number): number => Math.round(n * 1000);

export type CompareState = "agrees" | "differs" | "no_manual" | "no_pulse";

export type Comparison = {
  pulse: number | null;
  manual: number | null;
  /** Pulse minus manual, in AED to the fils; null when either side is missing. */
  difference: number | null;
  state: CompareState;
};

/** A month that has not been typed in is "no_manual", never zero; a Pulse figure that does not exist is "no_pulse". */
export function compare(
  pulse: number | null,
  manual: number | null,
  tolerance: number,
): Comparison {
  const p = pulse !== null && Number.isFinite(pulse) ? pulse : null;
  const m = manual !== null && Number.isFinite(manual) ? manual : null;
  if (m === null) return { pulse: p, manual: null, difference: null, state: "no_manual" };
  if (p === null) return { pulse: null, manual: m, difference: null, state: "no_pulse" };
  const diff = fils(p) - fils(m);
  const state = Math.abs(diff) <= fils(tolerance) ? "agrees" : "differs";
  return { pulse: p, manual: m, difference: diff / 1000, state };
}

export type MonthRow = { month: string; pulse: number | null; manual: number | null };

export type SwitchCheck = { ok: true } | { ok: false; reason: string };

/**
 * An area may be switched only when its two latest calendar months both agree: the newest must be `latestMonth` (the
 * last finished month, yyyy-mm), the one before it must be the month directly earlier (a gap breaks it), and both must
 * have a manual figure and a Pulse figure within the tolerance. Months are yyyy-mm.
 */
export function canSwitch(
  rows: readonly MonthRow[],
  latestMonth: string,
  tolerance: number,
): SwitchCheck {
  const previous = shiftMonth(latestMonth, -1);
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  for (const month of [latestMonth, previous]) {
    const r = byMonth.get(month);
    const c = compare(r?.pulse ?? null, r?.manual ?? null, tolerance);
    if (c.state === "no_manual") return { ok: false, reason: `No manual figure for ${month} yet.` };
    if (c.state === "no_pulse") return { ok: false, reason: `Pulse has no figure for ${month}.` };
    if (c.state === "differs") return { ok: false, reason: `${month} does not agree yet.` };
  }
  return { ok: true };
}

export type AreaStatus = "not_started" | "running" | "switched";

/** Not started until a manual figure exists; the stored decision wins after that. */
export function areaStatus(
  decision: "running" | "switched" | null,
  hasManual: boolean,
): AreaStatus {
  if (decision === "switched") return "switched";
  if (decision === "running" || hasManual) return "running";
  return "not_started";
}

/**
 * A switched area is never silently un-switched; if its two latest months no longer agree the page says so. Returns the
 * warning, or null.
 */
export function switchedWarning(status: AreaStatus, check: SwitchCheck): string | null {
  return status === "switched" && !check.ok
    ? `Marked switched, but the latest months no longer agree: ${check.reason}`
    : null;
}

/** The `count` months ending at `latestMonth`, newest first (yyyy-mm). */
export function lastMonths(latestMonth: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => shiftMonth(latestMonth, -i));
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Sum of a frozen per-owner figure (a bank account's reconciliation, a provider's statement) for each month. A month is
 * null ("not available yet") unless EVERY expected owner has a figure for it: a partial sum would pass for the whole.
 */
export function completeMonthTotals(
  rows: ReadonlyArray<{ month: string; owner: string; value: number | null }>,
  owners: ReadonlySet<string>,
  months: readonly string[],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const m of months) {
    const mine = rows.filter((r) => r.month.slice(0, 7) === m && owners.has(r.owner));
    const have = new Set(mine.filter((r) => r.value !== null).map((r) => r.owner));
    out[m] =
      owners.size > 0 && [...owners].every((o) => have.has(o))
        ? r3(mine.reduce((a, r) => a + (r.value ?? 0), 0))
        : null;
  }
  return out;
}
