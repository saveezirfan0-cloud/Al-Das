import { dayNumber } from "@/lib/documents/expiry";

/**
 * Collections forecast (pure): expected cash by week from what is still owed (the receivables ageing) and how each payer
 * has actually paid before. No machine learning, just percentiles, and every assumption is in fin_ref_finance_settings.
 *
 * For each payer, the lag between the claim date and the first payment is summarised by four percentiles (p25, p50, p75, p90).
 * They cut the lag into five slices holding 25 / 25 / 25 / 15 / 10 % of the payments (the last slice runs from p90 to
 * p90 + `tailWeeks`). A claim that is already `age` days old can only be paid in a slice that has not fully passed, so the
 * remaining slices are re-weighted, and the money is placed at the middle of each remaining slice. Each payer's share that is
 * expected to be collected at all is its collection rate over claims old enough to have been paid. Where a payer has fewer
 * than `minHistory` paid claims the org-wide defaults apply (lag = defaultLagDays with p25 = 0.5x, p75 = 1.5x, p90 = 2x;
 * rate = defaultCollectionRate), and the payer is marked as "assumed".
 */

export type OutstandingRow = {
  payer_id: string;
  week_start: string;
  claims: number;
  outstanding: number;
};

export type HistoryRow = {
  payer_id: string;
  paid_claims: number;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  mature_claims: number;
  collection_rate: number | null;
};

export type ForecastSettings = {
  horizonWeeks: number;
  defaultLagDays: number;
  defaultCollectionRate: number;
  minHistory: number;
  tailWeeks: number;
};

export type PayerForecast = {
  payerId: string;
  outstanding: number;
  expected: number;
  collectionRate: number;
  assumed: boolean;
  weeks: number[];
};

export type Forecast = {
  weekStarts: string[];
  weeks: number[];
  cumulative: number[];
  beyondHorizon: number;
  totalOutstanding: number;
  expectedTotal: number;
  notExpected: number;
  payers: PayerForecast[];
};

const MASS = [0.25, 0.25, 0.25, 0.15, 0.1];

const asNum = (v: unknown) => (v == null ? null : Number(v));

export function parseOutstanding(json: unknown): OutstandingRow[] {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      payer_id: String(o.payer_id ?? ""),
      week_start: String(o.week_start ?? ""),
      claims: Number(o.claims ?? 0),
      outstanding: Number(o.outstanding ?? 0),
    };
  });
}

export function parseHistory(json: unknown): HistoryRow[] {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      payer_id: String(o.payer_id ?? ""),
      paid_claims: Number(o.paid_claims ?? 0),
      p25: asNum(o.p25),
      p50: asNum(o.p50),
      p75: asNum(o.p75),
      p90: asNum(o.p90),
      mature_claims: Number(o.mature_claims ?? 0),
      collection_rate: asNum(o.collection_rate),
    };
  });
}

/** Monday of the week that contains the given day number. */
const mondayOf = (day: number) => day - ((day + 3) % 7);
const isoOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

type Slice = { lo: number; hi: number; mass: number };

function slicesFor(
  p: { p25: number; p50: number; p75: number; p90: number },
  tailDays: number,
): Slice[] {
  // percentiles must not decrease or the slices would overlap
  const p25 = Math.max(0, p.p25);
  const p50 = Math.max(p25, p.p50);
  const p75 = Math.max(p50, p.p75);
  const p90 = Math.max(p75, p.p90);
  const edges = [0, p25, p50, p75, p90, p90 + tailDays];
  return MASS.map((mass, i) => ({ lo: edges[i], hi: edges[i + 1], mass }));
}

/** Where the money of a claim that is `age` days old is expected, as [daysFromClaimDate, share] pairs summing to 1. */
export function expectedPayDays(
  age: number,
  slices: readonly Slice[],
  tailDays: number,
): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  for (const s of slices) {
    if (s.hi <= age) continue; // this slice has already passed
    if (s.hi === s.lo) {
      parts.push([Math.max(s.hi, age), s.mass]); // a zero-width slice: everything lands on that day
      continue;
    }
    const from = Math.max(s.lo, age);
    const share = (s.mass * (s.hi - from)) / (s.hi - s.lo);
    if (share > 0) parts.push([(from + s.hi) / 2, share]);
  }
  const total = parts.reduce((a, [, w]) => a + w, 0);
  if (total <= 0) {
    // older than every slice: assume it is paid within the tail window from now
    return [[age + tailDays / 2, 1]];
  }
  return parts.map(([d, w]) => [d, w / total]);
}

export function buildForecast(
  outstanding: readonly OutstandingRow[],
  history: readonly HistoryRow[],
  today: string,
  settings: ForecastSettings,
): Forecast {
  const todayN = dayNumber(today);
  if (todayN === null) throw new RangeError("today must be a valid YYYY-MM-DD date");
  const thisWeek = mondayOf(todayN);
  const horizon = Math.max(1, settings.horizonWeeks);
  const tailDays = settings.tailWeeks * 7;
  const D = settings.defaultLagDays;
  const byPayer = new Map(history.map((h) => [h.payer_id, h]));

  const weeks = new Array<number>(horizon).fill(0);
  let beyond = 0;
  const payers = new Map<string, PayerForecast>();

  for (const row of outstanding) {
    if (!(row.outstanding > 0)) continue;
    const h = byPayer.get(row.payer_id);
    const enoughLag =
      !!h &&
      h.paid_claims >= settings.minHistory &&
      h.p25 != null &&
      h.p50 != null &&
      h.p75 != null &&
      h.p90 != null;
    const enoughRate = !!h && h.mature_claims >= settings.minHistory && h.collection_rate != null;
    const slices = enoughLag
      ? slicesFor({ p25: h!.p25!, p50: h!.p50!, p75: h!.p75!, p90: h!.p90! }, tailDays)
      : slicesFor({ p25: D * 0.5, p50: D, p75: D * 1.5, p90: D * 2 }, tailDays);
    const rate = Math.min(
      1,
      Math.max(0, enoughRate ? h!.collection_rate! : settings.defaultCollectionRate),
    );

    let pf = payers.get(row.payer_id);
    if (!pf) {
      pf = {
        payerId: row.payer_id,
        outstanding: 0,
        expected: 0,
        collectionRate: rate,
        assumed: !(enoughLag && enoughRate),
        weeks: new Array<number>(horizon).fill(0),
      };
      payers.set(row.payer_id, pf);
    }
    pf.outstanding += row.outstanding;

    const claimDay = (dayNumber(row.week_start) ?? todayN) + 3; // middle of the claim week
    const age = Math.max(0, todayN - claimDay);
    for (const [daysFromClaim, share] of expectedPayDays(age, slices, tailDays)) {
      const amount = row.outstanding * rate * share;
      const payDay = Math.max(todayN, Math.round(claimDay + daysFromClaim));
      const idx = Math.floor((mondayOf(payDay) - thisWeek) / 7);
      pf.expected += amount;
      if (idx < horizon) {
        weeks[idx] += amount;
        pf.weeks[idx] += amount;
      } else beyond += amount;
    }
  }

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rounded = weeks.map(r2);
  let run = 0;
  const cumulative = rounded.map((w) => (run = r2(run + w)));
  const totalOutstanding = r2([...payers.values()].reduce((a, p) => a + p.outstanding, 0));
  const expectedTotal = r2(rounded.reduce((a, w) => a + w, 0) + beyond);
  return {
    weekStarts: rounded.map((_, i) => isoOf(thisWeek + i * 7)),
    weeks: rounded,
    cumulative,
    beyondHorizon: r2(beyond),
    totalOutstanding,
    expectedTotal,
    notExpected: r2(totalOutstanding - expectedTotal),
    payers: [...payers.values()]
      .map((p) => ({
        ...p,
        outstanding: r2(p.outstanding),
        expected: r2(p.expected),
        weeks: p.weeks.map(r2),
      }))
      .sort((a, b) => b.outstanding - a.outstanding || a.payerId.localeCompare(b.payerId)),
  };
}
