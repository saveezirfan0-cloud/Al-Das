/**
 * Fixed asset depreciation (Phase 22H), pure. Money is worked in integer fils (cents) and returned as numbers with two
 * decimals, so a schedule always adds up to exactly cost minus residual.
 *
 * Conventions (docs/22_PHASE_22H_NOTES.md):
 *   - Monthly depreciation, FULL-MONTH convention: an asset is depreciated for the whole month it is put in service,
 *     whatever the day, and for `lifeMonths` months from then. The month of disposal gets NO depreciation: a disposal
 *     charges depreciation up to the end of the month before (unless a run already charged more; posted depreciation is
 *     never written back).
 *   - Straight line: (cost - residual) spread evenly; each month's figure is the rounded cumulative minus the previous
 *     rounded cumulative, so rounding never drifts and the last month lands exactly on the residual.
 *   - Reducing balance: double declining (2 / life per month on the opening net book value), switching to straight line
 *     over the remaining months as soon as that is higher, so the asset reaches its residual exactly at the end of its
 *     life and never goes below it.
 *   - Runs catch up: a month's charge is the schedule's cumulative to that month minus what earlier posted months
 *     already charged (`runAmount`), so a back-dated asset or a missed month is caught up in the next run.
 */

export type DepreciationMethod = "straight_line" | "reducing_balance";

export const METHOD_LABELS: Record<DepreciationMethod, string> = {
  straight_line: "Straight line",
  reducing_balance: "Reducing balance",
};

export type DepreciationBasis = {
  cost: number;
  residual: number;
  lifeMonths: number;
  method: DepreciationMethod;
  /** YYYY-MM-DD; only the month counts (full-month convention). */
  inServiceDate: string;
};

const toFils = (n: number) => Math.round(Number((n * 100).toPrecision(15)));
const fromFils = (f: number) => f / 100;

/** "2026-10-17" or "2026-10" -> "2026-10-01". Null when not a valid month. */
export function monthStart(date: string): string | null {
  const m = /^(\d{4})-(\d{2})/.exec(date ?? "");
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** Whole months from `from` to `to` (both any date in the month): 2026-10 -> 2026-12 is 2. */
export function monthsBetween(from: string, to: string): number {
  const a = /^(\d{4})-(\d{2})/.exec(from);
  const b = /^(\d{4})-(\d{2})/.exec(to);
  if (!a || !b) return NaN;
  return (Number(b[1]) - Number(a[1])) * 12 + (Number(b[2]) - Number(a[2]));
}

/** The first day of the month `n` months after the month of `date`. */
export function addMonths(date: string, n: number): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m) throw new Error("invalid month");
  const idx = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-01`;
}

/** The last day of the month of `date`. */
export function monthEnd(date: string): string {
  const next = addMonths(date, 1);
  const d = new Date(`${next}T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/** What a basis may be: positive cost, residual below cost, a life of 1 to 600 months, a valid in-service date. */
export function basisProblem(b: DepreciationBasis): string | null {
  if (!(b.cost > 0) || !Number.isFinite(b.cost)) return "The cost must be above zero.";
  if (!(b.residual >= 0) || toFils(b.residual) >= toFils(b.cost))
    return "The residual value must be zero or more and below the cost.";
  if (!Number.isInteger(b.lifeMonths) || b.lifeMonths < 1 || b.lifeMonths > 600)
    return "The useful life is 1 to 600 months.";
  if (!monthStart(b.inServiceDate)) return "Enter the in-service date.";
  return null;
}

/** Monthly amounts (in fils) from the first month in service, `lifeMonths` long, summing to cost - residual. */
function scheduleFils(b: DepreciationBasis): number[] {
  const cost = toFils(b.cost);
  const residual = toFils(b.residual);
  const base = cost - residual;
  const n = b.lifeMonths;
  const out: number[] = [];
  if (b.method === "straight_line") {
    let prev = 0;
    for (let k = 1; k <= n; k++) {
      const cum = Math.round((base * k) / n);
      out.push(cum - prev);
      prev = cum;
    }
    return out;
  }
  // reducing balance: double declining, switching to straight line on the remaining months
  let nbv = cost;
  const rate = 2 / n;
  for (let k = 0; k < n; k++) {
    const remaining = n - k;
    const left = nbv - residual;
    const declining = Math.round(nbv * rate);
    const straight = Math.round(left / remaining);
    const charge = remaining === 1 ? left : Math.min(left, Math.max(declining, straight));
    out.push(charge);
    nbv -= charge;
  }
  return out;
}

/** The monthly schedule as amounts with two decimals. */
export function depreciationSchedule(b: DepreciationBasis): number[] {
  return scheduleFils(b).map(fromFils);
}

/** Index of `month` in the schedule: 0 = the in-service month; negative before it. */
export function scheduleIndex(b: DepreciationBasis, month: string): number {
  return monthsBetween(b.inServiceDate, month);
}

function cumulativeFils(b: DepreciationBasis, month: string, sched = scheduleFils(b)): number {
  const k = scheduleIndex(b, month);
  if (!(k >= 0)) return 0;
  const last = Math.min(k, sched.length - 1);
  let sum = 0;
  for (let i = 0; i <= last; i++) sum += sched[i];
  return sum;
}

/** Depreciation the schedule has charged up to and including `month` (0 before the in-service month). */
export function cumulativeThrough(b: DepreciationBasis, month: string): number {
  return fromFils(cumulativeFils(b, month));
}

/** The month's charge in a run: the cumulative to that month minus what posted months before it already charged. */
export function runAmount(b: DepreciationBasis, month: string, postedBefore: number): number {
  return fromFils(Math.max(0, cumulativeFils(b, month) - toFils(postedBefore)));
}

/** The month after which nothing more is charged (the last month of the life). */
export function lastDepreciationMonth(b: DepreciationBasis): string {
  return addMonths(b.inServiceDate, b.lifeMonths - 1);
}

export type DisposalFigures = {
  /**
   * The accumulated depreciation the disposal removes: the schedule through the month before disposal, or what is
   * already in the books if that is more (posted depreciation is never written back).
   */
  accumulated: number;
  /** accumulated - what is in the books: depreciation the disposal journal still charges (never negative). */
  catchUp: number;
  netBookValue: number;
  /** proceeds - net book value: a gain when positive, a loss when negative. */
  gainLoss: number;
};

export function disposalFigures(input: {
  basis: DepreciationBasis;
  disposalDate: string;
  postedAccumulated: number;
  proceeds: number;
}): DisposalFigures {
  const sched = scheduleFils(input.basis);
  const accumulated = Math.max(
    cumulativeFils(input.basis, addMonths(input.disposalDate, -1), sched),
    toFils(input.postedAccumulated),
  );
  const cost = toFils(input.basis.cost);
  const nbv = cost - accumulated;
  return {
    accumulated: fromFils(accumulated),
    catchUp: fromFils(accumulated - toFils(input.postedAccumulated)),
    netBookValue: fromFils(nbv),
    gainLoss: fromFils(toFils(input.proceeds) - nbv),
  };
}

export type ForecastAsset = DepreciationBasis & { postedAccumulated: number };

/**
 * Depreciation expected for `months` months from `fromMonth` (inclusive), per month, for assets still depreciating:
 * the first month also catches up anything the runs have not posted yet.
 */
export function depreciationForecast(
  assets: readonly ForecastAsset[],
  fromMonth: string,
  months = 12,
): Array<{ month: string; amount: number }> {
  const totals = new Array<number>(months).fill(0);
  for (const a of assets) {
    const sched = scheduleFils(a);
    let charged = toFils(a.postedAccumulated);
    for (let i = 0; i < months; i++) {
      const cum = cumulativeFils(a, addMonths(fromMonth, i), sched);
      if (cum > charged) {
        totals[i] += cum - charged;
        charged = cum;
      }
    }
  }
  return totals.map((t, i) => ({ month: addMonths(fromMonth, i), amount: fromFils(t) }));
}
