/** Pure aggregation for the extra Monthly-summary cards (ageing, claims by payer, denials). */

export type AgeingRow = {
  bucket: string;
  claim_activities: number | null;
  outstanding: number | null;
};
export const AGEING_BUCKETS = ["0-30", "31-60", "61-90", "90+"] as const;

export function ageingTotals(rows: readonly AgeingRow[]) {
  return AGEING_BUCKETS.map((bucket) => {
    const rs = rows.filter((r) => r.bucket === bucket);
    return {
      bucket,
      claimActivities: rs.reduce((n, r) => n + Number(r.claim_activities ?? 0), 0),
      outstanding: Math.round(rs.reduce((n, r) => n + Number(r.outstanding ?? 0), 0) * 100) / 100,
    };
  });
}

export type ClaimsStatusRow = {
  claim_year: number | null;
  claim_month: number | null;
  payer_id: string | null;
  submitted: number | null;
  accepted: number | null;
  rejected: number | null;
  pending: number | null;
  resubmitted: number | null;
  net: number | null;
  remitted: number | null;
  rejected_amount: number | null;
};

/** Does claim month (year, month) fall inside from..to ("yyyy-mm")? Rows without a month are kept out. */
export function claimInRange(r: ClaimsStatusRow, from: string, to: string): boolean {
  if (!r.claim_year || !r.claim_month) return false;
  const ym = `${r.claim_year}-${String(r.claim_month).padStart(2, "0")}`;
  return ym >= from && ym <= to;
}

export function claimsByPayer(
  rows: readonly ClaimsStatusRow[],
  payerNames: ReadonlyMap<string, string | null>,
) {
  const by = new Map<
    string,
    {
      payer: string;
      submitted: number;
      accepted: number;
      rejected: number;
      pending: number;
      net: number;
      remitted: number;
    }
  >();
  for (const r of rows) {
    const id = r.payer_id ?? "";
    const payer = (id && payerNames.get(id)) || id || "Unknown payer";
    const t = by.get(payer) ?? {
      payer,
      submitted: 0,
      accepted: 0,
      rejected: 0,
      pending: 0,
      net: 0,
      remitted: 0,
    };
    t.submitted += Number(r.submitted ?? 0);
    t.accepted += Number(r.accepted ?? 0);
    t.rejected += Number(r.rejected ?? 0);
    t.pending += Number(r.pending ?? 0);
    t.net += Number(r.net ?? 0);
    t.remitted += Number(r.remitted ?? 0);
    by.set(payer, t);
  }
  return [...by.values()]
    .map((t) => ({
      ...t,
      net: Math.round(t.net * 100) / 100,
      remitted: Math.round(t.remitted * 100) / 100,
      /** Share of claim activities with a rejection; null when nothing was submitted. */
      rejectionRate: t.submitted > 0 ? Math.round((t.rejected / t.submitted) * 1000) / 10 : null,
    }))
    .sort((a, b) => b.net - a.net || a.payer.localeCompare(b.payer));
}

export type DenialRow = {
  denial_type: string | null;
  last_denial_code: string | null;
  claim_activities: number | null;
  rejected_amount: number | null;
};

export function topDenials(rows: readonly DenialRow[], limit = 6) {
  const by = new Map<string, { label: string; claimActivities: number; amount: number }>();
  for (const r of rows) {
    const code = r.last_denial_code?.trim();
    const type = r.denial_type?.trim();
    const label = code ? (type ? `${code} · ${type}` : code) : type || "No denial code";
    const t = by.get(label) ?? { label, claimActivities: 0, amount: 0 };
    t.claimActivities += Number(r.claim_activities ?? 0);
    t.amount += Number(r.rejected_amount ?? 0);
    by.set(label, t);
  }
  return [...by.values()]
    .map((t) => ({ ...t, amount: Math.round(t.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label))
    .slice(0, limit);
}

/** Last day of "yyyy-mm" as yyyy-mm-dd (for drill-down links to Invoices). */
export function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
