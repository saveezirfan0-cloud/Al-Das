/** Parsing and small derived figures for the Insurance and receivables overview (fin_insurance_overview). Pure. */

export type InsuranceTotals = {
  submitted: number;
  accepted: number;
  rejected: number;
  pending: number;
  noStatus: number;
  resubmitted: number;
  claimed: number;
  acceptedAmount: number;
  rejectedAmount: number;
  paidAllocated: number;
  outstanding: number;
  paidClaims: number;
  avgDaysToPay: number | null;
  p90DaysToPay: number | null;
};
export type AgeBucket = {
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  claims: number;
  outstanding: number;
};
export type PayerOpen = {
  payerId: string;
  payerName: string | null;
  claims: number;
  rejected: number;
  outstanding: number;
};
export type InsuranceOverview = {
  totals: InsuranceTotals;
  ageing: AgeBucket[];
  payers: PayerOpen[];
};

const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const nn = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
const BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export function parseInsuranceOverview(raw: unknown): InsuranceOverview {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const t = (r.totals && typeof r.totals === "object" ? r.totals : {}) as Record<string, unknown>;
  const ageing = Array.isArray(r.ageing) ? (r.ageing as Array<Record<string, unknown>>) : [];
  const payers = Array.isArray(r.payers) ? (r.payers as Array<Record<string, unknown>>) : [];
  return {
    totals: {
      submitted: n(t.submitted),
      accepted: n(t.accepted),
      rejected: n(t.rejected),
      pending: n(t.pending),
      noStatus: n(t.no_status),
      resubmitted: n(t.resubmitted),
      claimed: n(t.claimed),
      acceptedAmount: n(t.accepted_amount),
      rejectedAmount: n(t.rejected_amount),
      paidAllocated: n(t.paid_allocated),
      outstanding: n(t.outstanding),
      paidClaims: n(t.paid_claims),
      avgDaysToPay: nn(t.avg_days_to_pay),
      p90DaysToPay: nn(t.p90_days_to_pay),
    },
    // always the four buckets, in order, so an empty bucket is shown as zero rather than missing
    ageing: BUCKETS.map((b) => {
      const x = ageing.find((a) => a.bucket === b);
      return { bucket: b, claims: n(x?.claims), outstanding: n(x?.outstanding) };
    }),
    payers: payers.map((p) => ({
      payerId: String(p.payer_id ?? "(no payer)"),
      payerName: typeof p.payer_name === "string" ? p.payer_name : null,
      claims: n(p.claims),
      rejected: n(p.rejected),
      outstanding: n(p.outstanding),
    })),
  };
}

/** Share of submitted claims, as a percentage with one decimal; null when nothing was submitted. */
export function rate(part: number, submitted: number): number | null {
  return submitted > 0 ? Math.round((part / submitted) * 1000) / 10 : null;
}
