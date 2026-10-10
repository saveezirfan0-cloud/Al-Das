/**
 * The Finance > Invoices list: filter parsing, claim progress and paging links as
 * pure functions, so the page stays a thin view.
 */

export const PAGE_SIZE = 50;

export type InvoiceSearch = {
  q?: string;
  from?: string;
  to?: string;
  branch?: string;
  doctor?: string;
  type?: string;
  page?: string;
};

export type InvoiceFilters = {
  q: string;
  from: string;
  to: string;
  branch: string;
  doctor: string;
  type: string;
  page: number;
};

/** PostgREST filter values must not carry grammar characters. */
export const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 80);

/** A real calendar date in YYYY-MM-DD form, or "" (so "2026-02-31" is dropped). */
export function day(v: string | undefined): string {
  const s = v ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? "" : s;
}

export function parseInvoiceFilters(sp: InvoiceSearch): InvoiceFilters {
  return {
    q: safe(sp.q),
    from: day(sp.from),
    to: day(sp.to),
    branch: safe(sp.branch),
    doctor: safe(sp.doctor),
    type: safe(sp.type),
    page: Math.max(1, Math.floor(Number(sp.page)) || 1),
  };
}

/** Message for an unusable filter combination, or null when the filters are fine. */
export function filterProblem(f: InvoiceFilters): string | null {
  return f.from && f.to && f.from > f.to ? "The “From” date is after the “To” date." : null;
}

/** How many filters (not counting the page) are narrowing the list. */
export function activeFilterCount(f: InvoiceFilters): number {
  return [f.q, f.from, f.to, f.branch, f.doctor, f.type].filter(Boolean).length;
}

/** Query string for a link to another page of the same filtered list. */
export function pageQuery(f: InvoiceFilters, page: number): string {
  const q = new URLSearchParams();
  for (const key of ["q", "from", "to", "branch", "doctor", "type"] as const) {
    if (f[key]) q.set(key, f[key]);
  }
  if (page > 1) q.set("page", String(page));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type ClaimProgress = "none" | "awaiting" | "partial" | "settled" | "rejected";

export const CLAIM_PROGRESS_LABEL: Record<ClaimProgress, string> = {
  none: "No claim",
  awaiting: "Awaiting payer",
  partial: "Part paid",
  settled: "Settled",
  rejected: "Rejected",
};

const num = (v: number | string | null | undefined) => (v == null ? 0 : Number(v) || 0);
// Sums are numeric(…,2); half a fils is below anything a payer can remit.
const EPS = 0.005;

/**
 * One-word summary of a row's claim sums from v_fin_invoice_list, for display only
 * (the exception rules that raise work live in SQL). `claimed` is the sum of claim
 * net, `remitted` and `rejected` come from the Diligence remittance.
 */
export function claimProgress(row: {
  claim_count: number | string | null;
  claimed: number | string | null;
  remitted: number | string | null;
  rejected: number | string | null;
}): ClaimProgress {
  if (num(row.claim_count) <= 0) return "none";
  const claimed = num(row.claimed);
  const remitted = num(row.remitted);
  const rejected = num(row.rejected);
  if (remitted <= EPS && rejected > EPS) return "rejected";
  if (claimed > EPS && remitted >= claimed - EPS) return "settled";
  if (remitted > EPS || rejected > EPS) return "partial";
  return "awaiting";
}
