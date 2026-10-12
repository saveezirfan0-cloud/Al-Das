/**
 * The month-end close pack: composing the snapshot that gets frozen, and comparing a frozen snapshot with the live figures
 * (pure). The snapshot holds aggregates only (branches, categories, departments, doctors by DHA id and name, payers, amounts):
 * no patient data. The database stores it as jsonb, hashes it, and (once finance and the CEO have both signed) locks it;
 * the XLSX and PDF are always rendered from the stored snapshot, never from live data, so a pack downloaded next year is
 * the pack that was signed.
 */

export type BranchFigures = {
  branch: string;
  generated: number;
  invoices: number;
  claimed: number;
  remitted: number;
  rejected: number;
  outstanding: number;
  claims: number;
  self_pay_collected: number;
};

export type MonthFigures = {
  by_branch: BranchFigures[];
  collections: Array<{ mode: string; paid: number; refunds: number }>;
  adjustments: { write_off: number; credit_note: number };
  ageing: Array<{ bucket: string; claims: number; outstanding: number }>;
  denials: {
    opened_in_month: number;
    active_now: number;
    active_amount: number;
    past_deadline: number;
  };
  remittance: {
    batches: number;
    lines: number;
    short_lines: number;
    short_amount: number;
    paid: number;
  };
  cashups: Array<{
    branch: string;
    days: number;
    expected: number;
    counted: number;
    variance: number;
  }>;
  open_exceptions: number;
  freshness: { last_capture_at: string | null; last_import_at: string | null };
};

export type RevenueLine = { key: string; label: string | null; net: number; invoices: number };
export type ReasonLine = {
  reason_code: string;
  description: string | null;
  claims: number;
  amount: number;
};

export type ClosePackInput = {
  orgName: string;
  month: string; // YYYY-MM-01
  builtAt: string; // ISO
  figures: MonthFigures;
  revenue: {
    by_category: RevenueLine[];
    by_department: RevenueLine[];
    by_doctor: RevenueLine[];
    by_branch: RevenueLine[];
  };
  denialReasons: ReasonLine[];
};

export type ClosePack = {
  version: 1;
  org: string;
  month: string;
  built_at: string;
  currency: "AED";
  totals: {
    generated: number;
    invoices: number;
    claimed: number;
    remitted: number;
    rejected: number;
    outstanding: number;
    claims: number;
    self_pay_collected: number;
    collected: number;
    refunds: number;
    revenue_net: number;
  };
  by_branch: BranchFigures[];
  collections: MonthFigures["collections"];
  adjustments: MonthFigures["adjustments"];
  ageing: MonthFigures["ageing"];
  revenue: ClosePackInput["revenue"];
  denials: MonthFigures["denials"];
  denial_reasons: ReasonLine[];
  remittance: MonthFigures["remittance"];
  cashups: MonthFigures["cashups"];
  open_exceptions: number;
  freshness: MonthFigures["freshness"];
  notes: string[];
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const sum = (xs: readonly number[]) => r2(xs.reduce((a, x) => a + (Number.isFinite(x) ? x : 0), 0));
const top = <T>(rows: readonly T[], n: number) => rows.slice(0, n);

export function buildClosePack(input: ClosePackInput): ClosePack {
  const f = input.figures;
  const revenueNet = sum(input.revenue.by_category.map((r) => r.net));
  return {
    version: 1,
    org: input.orgName,
    month: input.month,
    built_at: input.builtAt,
    currency: "AED",
    totals: {
      generated: sum(f.by_branch.map((b) => b.generated)),
      invoices: f.by_branch.reduce((a, b) => a + b.invoices, 0),
      claimed: sum(f.by_branch.map((b) => b.claimed)),
      remitted: sum(f.by_branch.map((b) => b.remitted)),
      rejected: sum(f.by_branch.map((b) => b.rejected)),
      outstanding: sum(f.by_branch.map((b) => b.outstanding)),
      claims: f.by_branch.reduce((a, b) => a + b.claims, 0),
      self_pay_collected: sum(f.by_branch.map((b) => b.self_pay_collected)),
      collected: sum(f.collections.map((c) => c.paid)),
      refunds: sum(f.collections.map((c) => c.refunds)),
      revenue_net: revenueNet,
    },
    by_branch: f.by_branch,
    collections: f.collections,
    adjustments: f.adjustments,
    ageing: f.ageing,
    revenue: {
      by_category: top(input.revenue.by_category, 50),
      by_department: top(input.revenue.by_department, 50),
      by_doctor: top(input.revenue.by_doctor, 50),
      by_branch: top(input.revenue.by_branch, 20),
    },
    denials: f.denials,
    denial_reasons: top(input.denialReasons, 10),
    remittance: f.remittance,
    cashups: f.cashups,
    open_exceptions: f.open_exceptions,
    freshness: f.freshness,
    notes: [
      "Figures are taken from the Unite invoice mirror and the Diligence claims file as they stood when this pack was built.",
      "Claimed, remitted, rejected and outstanding are by the claim's transaction month. Receivables ageing and outstanding are as of the build date, not month end.",
      "Revenue is the net of current invoice lines for invoices dated in the month; self-pay collected is payments dated in the month on self-pay invoices.",
    ],
  };
}

/** Coerces the stored jsonb back to the typed shape (defensive: a locked pack may be years old). */
export function readClosePack(json: unknown): ClosePack | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Partial<ClosePack>;
  if (o.version !== 1 || !o.month || !o.totals || !Array.isArray(o.by_branch)) return null;
  return o as ClosePack;
}

export type DriftRow = { metric: string; frozen: number; live: number; difference: number };

/**
 * Differences between a frozen pack and what the live mirror says now for the same month. Unite re-sends an amended
 * invoice and Diligence files keep arriving, so a locked month can drift; the pack itself never changes. Rows within a
 * cent are not drift.
 */
export function packDrift(pack: ClosePack, live: MonthFigures, liveRevenueNet: number): DriftRow[] {
  const liveTotals = {
    generated: sum(live.by_branch.map((b) => b.generated)),
    claimed: sum(live.by_branch.map((b) => b.claimed)),
    remitted: sum(live.by_branch.map((b) => b.remitted)),
    rejected: sum(live.by_branch.map((b) => b.rejected)),
    self_pay_collected: sum(live.by_branch.map((b) => b.self_pay_collected)),
    collected: sum(live.collections.map((c) => c.paid)),
    revenue_net: liveRevenueNet,
  };
  const rows: DriftRow[] = [];
  for (const [metric, liveValue] of Object.entries(liveTotals)) {
    const frozen = pack.totals[metric as keyof typeof liveTotals] ?? 0;
    const difference = r2(liveValue - frozen);
    if (Math.abs(difference) >= 0.01) rows.push({ metric, frozen, live: liveValue, difference });
  }
  return rows;
}

export const METRIC_LABELS: Record<string, string> = {
  generated: "Invoiced (net)",
  claimed: "Claimed",
  remitted: "Remitted",
  rejected: "Rejected",
  self_pay_collected: "Self-pay collected",
  collected: "Collected (all payments)",
  revenue_net: "Revenue (line net)",
};

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const names = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return `${names[(m ?? 1) - 1] ?? month} ${y}`;
}
