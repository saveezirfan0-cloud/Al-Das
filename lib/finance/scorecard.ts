/**
 * Payer scorecard presentation rules (pure). The numbers come from the SQL function fin_payer_scorecard; this module turns
 * them into rates and traffic lights using the thresholds in fin_ref_finance_settings. A row with fewer claims than
 * `minClaims` is never coloured: a denial rate over four claims says nothing.
 */

export type ScorecardRow = {
  group_key: string;
  group_label: string | null;
  claims: number;
  denied_claims: number;
  net: number;
  remitted: number;
  rejected: number;
  paid_claims: number;
  avg_days_to_pay: number | null;
  p90_days_to_pay: number | null;
};

export type ScorecardThresholds = {
  minClaims: number;
  denialRateWarn: number;
  denialRateAlert: number;
  daysToPayWarn: number;
  daysToPayAlert: number;
};

export type Rag = "green" | "amber" | "red" | "grey";

export type ScorecardMetrics = ScorecardRow & {
  /** denied claims / claims, 0..1 */
  denialRate: number;
  /** rejected amount / claimed amount, 0..1 (null without any claimed amount) */
  amountDenialRate: number | null;
  /** remitted / claimed, 0..1 (null without any claimed amount) */
  collectionRate: number | null;
  lowSample: boolean;
  denialRag: Rag;
  daysRag: Rag;
};

const num = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0));

/** Rows from the database arrive as JSON; coerce numerics and null the optional ones. */
export function parseScorecardRows(json: unknown): ScorecardRow[] {
  if (!Array.isArray(json)) return [];
  return json.map((r) => {
    const o = r as Record<string, unknown>;
    return {
      group_key: String(o.group_key ?? ""),
      group_label: o.group_label == null ? null : String(o.group_label),
      claims: num(o.claims),
      denied_claims: num(o.denied_claims),
      net: num(o.net),
      remitted: num(o.remitted),
      rejected: num(o.rejected),
      paid_claims: num(o.paid_claims),
      avg_days_to_pay: o.avg_days_to_pay == null ? null : num(o.avg_days_to_pay),
      p90_days_to_pay: o.p90_days_to_pay == null ? null : num(o.p90_days_to_pay),
    };
  });
}

function rag(value: number | null, warn: number, alert: number, low: boolean): Rag {
  if (low || value === null) return "grey";
  if (value >= alert) return "red";
  if (value >= warn) return "amber";
  return "green";
}

export function scorecardMetrics(row: ScorecardRow, th: ScorecardThresholds): ScorecardMetrics {
  const lowSample = row.claims < th.minClaims;
  const denialRate = row.claims > 0 ? row.denied_claims / row.claims : 0;
  return {
    ...row,
    denialRate,
    amountDenialRate: row.net > 0 ? row.rejected / row.net : null,
    collectionRate: row.net > 0 ? row.remitted / row.net : null,
    lowSample,
    denialRag: rag(denialRate, th.denialRateWarn, th.denialRateAlert, lowSample),
    // days to pay is judged on the paid claims, so the sample is the number of paid claims
    daysRag: rag(
      row.avg_days_to_pay,
      th.daysToPayWarn,
      th.daysToPayAlert,
      row.paid_claims < th.minClaims,
    ),
  };
}

export const SORTS = ["claims", "denial_rate", "days_to_pay", "rejected"] as const;
export type ScorecardSort = (typeof SORTS)[number];

export function sortScorecard(rows: ScorecardMetrics[], by: ScorecardSort): ScorecardMetrics[] {
  const key = (r: ScorecardMetrics) =>
    by === "claims"
      ? r.claims
      : by === "denial_rate"
        ? r.denialRate
        : by === "rejected"
          ? r.rejected
          : (r.avg_days_to_pay ?? -1);
  return [...rows].sort((a, b) => key(b) - key(a) || a.group_key.localeCompare(b.group_key));
}

export const pct = (v: number | null, digits = 1) =>
  v === null ? "n/a" : `${(v * 100).toFixed(digits)}%`;
