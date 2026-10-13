import { toCsv } from "@/lib/csv";

/**
 * Insurance follow-up and receivables by age (Phase 20I, docs/20_PHASE_20I_NOTES.md). Pure.
 *
 * The same rules run in SQL (fin_followup_open_claims, fin_followup_worklist, fin_receivables_by_payer_age and
 * fin_followup_create_tasks, migration 20261026000100); tests/db/finance-followup.test.ts checks the two agree on the shared
 * synthetic fixture tests/unit/finance/fixtures/followup.synthetic.json.
 *
 *  - A claim is OPEN when its outstanding amount is above zero: net less remitted less an APPROVED write-off (the same
 *    formula as fin_insurance_overview). "Evidenced" (accepted) is a remitted amount or a status listed in
 *    fin_ref_finance_settings.accepted_claim_statuses, as everywhere else.
 *  - Age is days from the claim's transaction date to "today" in the clinic's time zone. A claim without a date has no age:
 *    it is shown in its own "No date" column and never reaches a follow-up stage (fails closed rather than guessing).
 *  - Ageing buckets come from fin_ref_finance_settings.ageing_bucket_days (default 30, 60, 90, 120 giving 0-30, 31-60,
 *    61-90, 91-120 and 120+). Follow-up stages come from followup_stage_days (default 60, 90, 120). Nothing is hardcoded.
 */

export const DEFAULT_BUCKET_DAYS = [30, 60, 90, 120] as const;
export const DEFAULT_STAGE_DAYS = [60, 90, 120] as const;

/** Strictly increasing whole days between 1 and 3650, at most `max` of them (the SQL check app.fin_valid_day_steps). */
export function validDaySteps(days: readonly number[], max: number): boolean {
  if (!Array.isArray(days) || days.length < 1 || days.length > max) return false;
  return days.every(
    (d, i) => Number.isInteger(d) && d >= 1 && d <= 3650 && (i === 0 || d > days[i - 1]),
  );
}

/** "30, 60, 90" (commas, spaces or semicolons) -> [30, 60, 90]; null when it is not a valid list. */
export function parseDaySteps(raw: string, max: number): number[] | null {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  const days = parts.map(Number);
  return validDaySteps(days, max) ? days : null;
}

export type Bucket = { index: number; label: string; from: number; to: number | null };

/** The buckets for a list of upper bounds: [30, 60] -> 0-30, 31-60, 60+. */
export function ageingBuckets(days: readonly number[]): Bucket[] {
  const out: Bucket[] = days.map((d, i) => ({
    index: i,
    label: i === 0 ? `0-${d}` : `${days[i - 1] + 1}-${d}`,
    from: i === 0 ? 0 : days[i - 1] + 1,
    to: d,
  }));
  const last = days[days.length - 1];
  out.push({ index: days.length, label: `${last}+`, from: last + 1, to: null });
  return out;
}

/** Which bucket an age falls in (0 = the first). A negative age (dated in the future) is the first bucket; no age is null. */
export function bucketIndex(ageDays: number | null, days: readonly number[]): number | null {
  if (ageDays === null || !Number.isFinite(ageDays)) return null;
  return days.filter((d) => ageDays > d).length;
}

/** The highest follow-up stage an age has reached (60, 90, 120 ...), or null before the first. */
export function stageReached(ageDays: number | null, stages: readonly number[]): number | null {
  if (ageDays === null || !Number.isFinite(ageDays)) return null;
  let reached: number | null = null;
  for (const s of stages) if (ageDays >= s) reached = s;
  return reached;
}

const DAY = 86_400_000;
const dayNo = (iso: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? Math.round(t / DAY) : null;
};
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Whole days from `from` to `to` (both yyyy-mm-dd); null when either is missing or invalid. */
export function daysBetween(from: string | null | undefined, to: string): number | null {
  if (!from) return null;
  const a = dayNo(from);
  const b = dayNo(to);
  return a === null || b === null ? null : b - a;
}

/** The day a claim dated `transactionDate` reaches `stage` days. */
export function crossingDate(transactionDate: string, stage: number): string | null {
  const n = dayNo(transactionDate);
  return n === null ? null : isoOf(n + stage);
}

/**
 * The stages a claim has crossed that the daily job may still raise a task for: crossed on or before today AND on or after
 * the switch-on date. With no switch-on date nothing is due (the job is off), so go-live never floods historic claims.
 */
export function stagesDue(
  transactionDate: string | null,
  stages: readonly number[],
  startDate: string | null,
  today: string,
): Array<{ stage: number; crossedOn: string }> {
  if (!transactionDate || !startDate) return [];
  const t = dayNo(today);
  const s = dayNo(startDate);
  if (t === null || s === null) return [];
  const out: Array<{ stage: number; crossedOn: string }> = [];
  for (const stage of stages) {
    const on = crossingDate(transactionDate, stage);
    const n = on ? dayNo(on) : null;
    if (on && n !== null && n <= t && n >= s) out.push({ stage, crossedOn: on });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------------
// Claims: outstanding, evidenced, worklist rows
// ------------------------------------------------------------------------------------------------------------------

export type ClaimInput = {
  id: string;
  claimActivityNumber: string;
  payerId: string | null;
  branch: string | null;
  transactionDate: string | null;
  net: number | null;
  remitted: number | null;
  rejected: number | null;
  writeOff: number | null;
  writeOffStatus: string | null;
  claimStatus: string | null;
  resubmissionCount: number | null;
  lastResubmissionDate: string | null;
};

const num = (v: unknown) => (Number.isFinite(Number(v)) && v !== null ? Number(v) : 0);
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Net less remitted less an APPROVED write-off, never below zero (fin_insurance_overview's formula). */
export function outstandingOf(
  c: Pick<ClaimInput, "net" | "remitted" | "writeOff" | "writeOffStatus">,
) {
  const wo = (c.writeOffStatus ?? "").toLowerCase() === "approved" ? num(c.writeOff) : 0;
  return round2(Math.max(num(c.net) - num(c.remitted) - wo, 0));
}

/** Accepted only with evidence: a remitted amount, or a status finance listed (case-insensitive, trimmed). */
export function isEvidenced(
  c: Pick<ClaimInput, "remitted" | "claimStatus">,
  acceptedStatuses: readonly string[],
): boolean {
  if (num(c.remitted) > 0) return true;
  const s = (c.claimStatus ?? "").trim().toLowerCase();
  return s !== "" && acceptedStatuses.some((x) => x.trim().toLowerCase() === s);
}

export type FollowupRow = {
  id: string;
  claimActivityNumber: string;
  payerId: string | null;
  branch: string | null;
  transactionDate: string | null;
  ageDays: number | null;
  bucket: number | null;
  stage: number | null;
  net: number;
  remitted: number;
  outstanding: number;
  rejected: number;
  evidenced: boolean;
};

/** The open claims as the worklist sees them (closed ones dropped), oldest first. */
export function followupRows(
  claims: readonly ClaimInput[],
  opts: {
    today: string;
    bucketDays: readonly number[];
    stageDays: readonly number[];
    acceptedStatuses: readonly string[];
  },
): FollowupRow[] {
  return claims
    .map((c) => {
      const ageDays = daysBetween(c.transactionDate, opts.today);
      return {
        id: c.id,
        claimActivityNumber: c.claimActivityNumber,
        payerId: c.payerId,
        branch: c.branch,
        transactionDate: c.transactionDate,
        ageDays,
        bucket: bucketIndex(ageDays, opts.bucketDays),
        stage: stageReached(ageDays, opts.stageDays),
        net: round2(num(c.net)),
        remitted: round2(num(c.remitted)),
        outstanding: outstandingOf(c),
        rejected: round2(num(c.rejected)),
        evidenced: isEvidenced(c, opts.acceptedStatuses),
      };
    })
    .filter((r) => r.outstanding > 0)
    .sort(
      (a, b) =>
        (b.ageDays ?? -Infinity) - (a.ageDays ?? -Infinity) ||
        a.claimActivityNumber.localeCompare(b.claimActivityNumber),
    );
}

// ------------------------------------------------------------------------------------------------------------------
// Receivables by payer and age (candidate "ARP report", OQ-95)
// ------------------------------------------------------------------------------------------------------------------

export type ReceivableCell = { bucket: number | null; claims: number; outstanding: number };
export type ReceivablePayer = {
  payerId: string;
  payerName: string | null;
  cells: ReceivableCell[]; // one per bucket in order, then the "No date" cell (bucket null)
  claims: number;
  outstanding: number;
};
export type ReceivablesMatrix = {
  buckets: Bucket[];
  payers: ReceivablePayer[];
  totals: { cells: ReceivableCell[]; claims: number; outstanding: number };
};

export const NO_PAYER = "(no payer)";

/** Raw aggregate row: payer, bucket (null = no date), count and amount. What the SQL returns. */
export type ReceivableAggregate = {
  payerId: string | null;
  payerName?: string | null;
  bucket: number | null;
  claims: number;
  outstanding: number;
};

/** Open claims -> payer x bucket aggregates (the pure twin of fin_receivables_by_payer_age). */
export function aggregateReceivables(rows: readonly FollowupRow[]): ReceivableAggregate[] {
  const by = new Map<string, ReceivableAggregate>();
  for (const r of rows) {
    const payer = r.payerId ?? NO_PAYER;
    const key = `${payer}\u0000${r.bucket ?? "x"}`;
    const a = by.get(key) ?? { payerId: payer, bucket: r.bucket, claims: 0, outstanding: 0 };
    a.claims += 1;
    a.outstanding = round2(a.outstanding + r.outstanding);
    by.set(key, a);
  }
  return [...by.values()];
}

/** Aggregates -> the matrix: every bucket present for every payer (zeros shown), payers by amount, a totals row. */
export function receivablesMatrix(
  aggregates: readonly ReceivableAggregate[],
  bucketDays: readonly number[],
): ReceivablesMatrix {
  const buckets = ageingBuckets(bucketDays);
  const slots: Array<number | null> = [...buckets.map((b) => b.index), null];
  const emptyCells = () => slots.map((b) => ({ bucket: b, claims: 0, outstanding: 0 }));
  const payers = new Map<string, ReceivablePayer>();
  const totals = { cells: emptyCells(), claims: 0, outstanding: 0 };
  for (const a of aggregates) {
    const id = a.payerId ?? NO_PAYER;
    const p = payers.get(id) ?? {
      payerId: id,
      payerName: a.payerName ?? null,
      cells: emptyCells(),
      claims: 0,
      outstanding: 0,
    };
    if (!p.payerName && a.payerName) p.payerName = a.payerName;
    // a bucket beyond the list (settings changed between query and render) joins the last one; never dropped
    const idx =
      a.bucket === null ? slots.length - 1 : Math.min(Math.max(a.bucket, 0), buckets.length - 1);
    for (const target of [p.cells[idx], totals.cells[idx]]) {
      target.claims += a.claims;
      target.outstanding = round2(target.outstanding + a.outstanding);
    }
    p.claims += a.claims;
    p.outstanding = round2(p.outstanding + a.outstanding);
    totals.claims += a.claims;
    totals.outstanding = round2(totals.outstanding + a.outstanding);
    payers.set(id, p);
  }
  return {
    buckets,
    payers: [...payers.values()].sort(
      (a, b) => b.outstanding - a.outstanding || a.payerId.localeCompare(b.payerId),
    ),
    totals,
  };
}

/** The matrix as CSV: amount and count per bucket, then the totals. Payer ids and names only. */
export function receivablesCsv(m: ReceivablesMatrix, asOf: string): string {
  const labels = [...m.buckets.map((b) => b.label), "No date"];
  const headers = [
    "As of",
    "Payer ID",
    "Payer",
    ...labels.flatMap((l) => [`${l} (AED)`, `${l} (claims)`]),
    "Total outstanding (AED)",
    "Total claims",
  ];
  const line = (id: string, name: string, cells: ReceivableCell[], claims: number, amt: number) => [
    asOf,
    id,
    name,
    ...cells.flatMap((c) => [c.outstanding.toFixed(2), c.claims]),
    amt.toFixed(2),
    claims,
  ];
  return toCsv(headers, [
    ...m.payers.map((p) => line(p.payerId, p.payerName ?? "", p.cells, p.claims, p.outstanding)),
    line("TOTAL", "", m.totals.cells, m.totals.claims, m.totals.outstanding),
  ]);
}

// ------------------------------------------------------------------------------------------------------------------
// Follow-up records
// ------------------------------------------------------------------------------------------------------------------

export const FOLLOWUP_OUTCOMES = [
  "contacted",
  "promised",
  "resubmitted",
  "disputed",
  "write_off_proposed",
  "paid_elsewhere",
  "other",
] as const;
export type FollowupOutcome = (typeof FOLLOWUP_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<FollowupOutcome, string> = {
  contacted: "Payer contacted",
  promised: "Payment promised",
  resubmitted: "Resubmitted",
  disputed: "Disputed by the payer",
  write_off_proposed: "Write-off proposed",
  paid_elsewhere: "Paid (another reference)",
  other: "Other",
};

export const FOLLOWUP_NOTE_MAX = 1000;

/** The fixed task subject: the stage only. No claim number, payer, amount or patient detail. */
export function followupTaskSubject(stage: number): string {
  return `Insurance claim follow-up: ${stage} days unpaid`;
}

// ------------------------------------------------------------------------------------------------------------------
// Parsing what the SQL functions return
// ------------------------------------------------------------------------------------------------------------------

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
const int = (v: unknown) =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
const intList = (v: unknown, fallback: readonly number[]) =>
  Array.isArray(v) && v.every((x) => Number.isInteger(Number(x))) ? v.map(Number) : [...fallback];

export type WorklistRow = FollowupRow & {
  invoiceNo: string | null;
  payerName: string | null;
  claimStatus: string | null;
  resubmissionCount: number;
  lastResubmissionDate: string | null;
  lastFollowup: {
    stage: number | null;
    outcome: FollowupOutcome;
    note: string | null;
    nextActionDate: string | null;
    createdAt: string;
  } | null;
  task: { stage: number; taskId: string | null; done: boolean; assigneeId: string | null } | null;
};

export type Worklist = {
  today: string;
  bucketDays: number[];
  stageDays: number[];
  tasksFrom: string | null;
  tasksEnabled: boolean;
  total: number;
  totalOutstanding: number;
  byStage: Array<{ stage: number | null; claims: number; outstanding: number }>;
  payers: Array<{ payerId: string; payerName: string | null }>;
  branches: string[];
  rows: WorklistRow[];
};

export function parseWorklist(raw: unknown): Worklist {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>) : []);
  return {
    today: String(r.today ?? ""),
    bucketDays: intList(r.bucket_days, DEFAULT_BUCKET_DAYS),
    stageDays: intList(r.stage_days, DEFAULT_STAGE_DAYS),
    tasksFrom: str(r.tasks_from),
    tasksEnabled: r.tasks_enabled === true,
    total: num(r.total),
    totalOutstanding: num(r.total_outstanding),
    byStage: arr(r.by_stage).map((s) => ({
      stage: int(s.stage),
      claims: num(s.claims),
      outstanding: num(s.outstanding),
    })),
    payers: arr(r.payers).map((p) => ({
      payerId: String(p.payer_id ?? NO_PAYER),
      payerName: str(p.payer_name),
    })),
    branches: Array.isArray(r.branches) ? (r.branches as unknown[]).map(String) : [],
    rows: arr(r.rows).map((x) => {
      const f = x.last_followup as Record<string, unknown> | null | undefined;
      const t = x.task as Record<string, unknown> | null | undefined;
      return {
        id: String(x.id),
        claimActivityNumber: String(x.claim_activity_number ?? ""),
        invoiceNo: str(x.invoice_no),
        payerId: str(x.payer_id),
        payerName: str(x.payer_name),
        branch: str(x.branch_code),
        transactionDate: str(x.transaction_date),
        ageDays: int(x.age_days),
        bucket: int(x.bucket),
        stage: int(x.stage),
        net: num(x.net),
        remitted: num(x.remitted),
        outstanding: num(x.outstanding),
        rejected: num(x.rejected),
        evidenced: x.evidenced === true,
        claimStatus: str(x.claim_status),
        resubmissionCount: num(x.resubmission_count),
        lastResubmissionDate: str(x.last_resubmission_date),
        lastFollowup:
          f && typeof f === "object"
            ? {
                stage: int(f.stage),
                outcome: (FOLLOWUP_OUTCOMES as readonly string[]).includes(String(f.outcome))
                  ? (f.outcome as FollowupOutcome)
                  : "other",
                note: str(f.note),
                nextActionDate: str(f.next_action_date),
                createdAt: String(f.created_at ?? ""),
              }
            : null,
        task:
          t && typeof t === "object"
            ? {
                stage: num(t.stage),
                taskId: str(t.task_id),
                done: t.done === true,
                assigneeId: str(t.assignee_id),
              }
            : null,
      };
    }),
  };
}

export type ReceivablesResult = {
  today: string;
  bucketDays: number[];
  aggregates: ReceivableAggregate[];
};

export function parseReceivables(raw: unknown): ReceivablesResult {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rows = Array.isArray(r.rows) ? (r.rows as Array<Record<string, unknown>>) : [];
  return {
    today: String(r.today ?? ""),
    bucketDays: intList(r.bucket_days, DEFAULT_BUCKET_DAYS),
    aggregates: rows.map((x) => ({
      payerId: str(x.payer_id) ?? NO_PAYER,
      payerName: str(x.payer_name),
      bucket: int(x.bucket),
      claims: num(x.claims),
      outstanding: num(x.outstanding),
    })),
  };
}

/** A stage label for the UI: "60 days", or "Not yet due" before the first stage. */
export function stageLabel(stage: number | null): string {
  return stage === null ? "Not yet due" : `${stage} days`;
}
