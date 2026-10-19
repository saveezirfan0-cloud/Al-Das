import { addDays, daysUntil } from "@/lib/documents/expiry";

/**
 * Denial management rules (pure): the reason-code taxonomy lookup, the resubmission deadline and its countdown, and the
 * case workflow. The nightly SQL function fin_sync_denial_cases applies the same lookup (exact code, then its family
 * = the leading letters, then the org default); tests/db/finance-denials.test.ts checks the two agree.
 */

export const DENIAL_CATEGORIES = [
  "authorization",
  "eligibility",
  "medical_necessity",
  "coding",
  "documentation",
  "duplicate",
  "timely_filing",
  "pricing",
  "other",
] as const;
export type DenialCategory = (typeof DENIAL_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<DenialCategory, string> = {
  authorization: "Authorisation",
  eligibility: "Eligibility",
  medical_necessity: "Medical necessity",
  coding: "Coding or billing",
  documentation: "Documentation",
  duplicate: "Duplicate",
  timely_filing: "Late submission",
  pricing: "Pricing",
  other: "Other",
};

export type OwnerRole = "insurance" | "billing" | "finance" | "admin";

/**
 * Where a rejection came from and whether the clinic could have prevented it. Both are DATA: columns `origin` and
 * `avoidable` of fin_ref_denial_codes, edited by Finance in Workflow settings (seeded once from a proposed table by
 * category, docs/48). Null means not classified: shown as "Not classified", never read as "not avoidable".
 */
export const REJECTION_ORIGINS = ["front_desk", "clinical", "billing", "payer"] as const;
export type RejectionOrigin = (typeof REJECTION_ORIGINS)[number];

export const ORIGIN_LABELS: Record<RejectionOrigin, string> = {
  front_desk: "Front desk",
  clinical: "Clinical",
  billing: "Billing",
  payer: "Payer",
};
export const NOT_CLASSIFIED = "Not classified";

/** A database value as an origin; anything else (blank, unknown word) is not classified. */
export function asRejectionOrigin(v: unknown): RejectionOrigin | null {
  return typeof v === "string" && (REJECTION_ORIGINS as readonly string[]).includes(v)
    ? (v as RejectionOrigin)
    : null;
}

export type OriginResult = { origin: RejectionOrigin | null; avoidable: boolean | null };

/** Origin and avoidable flag for a denial code, through the same taxonomy lookup the case uses (exact, then family). */
export function rejectionOrigin(
  code: string | null | undefined,
  table: readonly DenialCodeRow[],
): OriginResult {
  const row = lookupDenialCode(code, table);
  if (!row) return { origin: null, avoidable: null };
  return {
    origin: asRejectionOrigin(row.origin),
    avoidable: typeof row.avoidable === "boolean" ? row.avoidable : null,
  };
}

export const avoidableLabel = (a: boolean | null) =>
  a === true ? "Avoidable" : a === false ? "Not avoidable" : NOT_CLASSIFIED;

export type BreakdownCell = { count: number; amount: number };
export type OriginBreakdown = {
  /** One row per origin in REJECTION_ORIGINS order, then "not classified" (origin null). */
  byOrigin: Array<{ origin: RejectionOrigin | null } & BreakdownCell>;
  avoidable: BreakdownCell;
  notAvoidable: BreakdownCell;
  notClassified: BreakdownCell;
  total: BreakdownCell;
};

/**
 * Counts and denied amounts by origin and by avoidable / not avoidable / not classified (pure). Amounts are summed in
 * fils so the parts always add up to the total; a blank or non-numeric amount counts the case with 0.
 */
export function originBreakdown(
  cases: ReadonlyArray<{ reasonCode: string | null; amount: number | string | null }>,
  table: readonly DenialCodeRow[],
): OriginBreakdown {
  const keys = [...REJECTION_ORIGINS, null] as const;
  const origin = new Map<RejectionOrigin | null, { count: number; fils: number }>(
    keys.map((k) => [k, { count: 0, fils: 0 }]),
  );
  const av = { yes: { count: 0, fils: 0 }, no: { count: 0, fils: 0 }, none: { count: 0, fils: 0 } };
  const total = { count: 0, fils: 0 };
  for (const c of cases) {
    const n = Number(c.amount);
    const fils =
      c.amount !== null && c.amount !== "" && Number.isFinite(n) ? Math.round(n * 100) : 0;
    const r = rejectionOrigin(c.reasonCode, table);
    const o = origin.get(r.origin)!;
    o.count += 1;
    o.fils += fils;
    const a = r.avoidable === true ? av.yes : r.avoidable === false ? av.no : av.none;
    a.count += 1;
    a.fils += fils;
    total.count += 1;
    total.fils += fils;
  }
  const cell = (x: { count: number; fils: number }): BreakdownCell => ({
    count: x.count,
    amount: x.fils / 100,
  });
  return {
    byOrigin: keys.map((k) => ({ origin: k, ...cell(origin.get(k)!) })),
    avoidable: cell(av.yes),
    notAvoidable: cell(av.no),
    notClassified: cell(av.none),
    total: cell(total),
  };
}

export type DenialCodeRow = {
  code: string;
  isFamily: boolean;
  description: string;
  category: DenialCategory;
  defaultOwnerRole: OwnerRole;
  resubmitDays: number | null;
  appealable: boolean;
  active: boolean;
  /** Where the rejection came from (data); missing or null = not classified. */
  origin?: RejectionOrigin | null;
  /** Could the clinic have prevented it (data); missing or null = not classified. */
  avoidable?: boolean | null;
};

/** The leading letters of a code ("MNEC-003" -> "MNEC"), upper-case; null when it does not start with letters. */
export function familyOf(code: string | null | undefined): string | null {
  const m = /^[A-Za-z]+/.exec((code ?? "").trim());
  return m ? m[0].toUpperCase() : null;
}

/** Exact code first, then the family row. Inactive rows never match. */
export function lookupDenialCode(
  code: string | null | undefined,
  table: readonly DenialCodeRow[],
): DenialCodeRow | null {
  const c = (code ?? "").trim().toUpperCase();
  if (!c) return null;
  const live = table.filter((r) => r.active);
  const exact = live.find((r) => !r.isFamily && r.code.toUpperCase() === c);
  if (exact) return exact;
  const fam = familyOf(c);
  return (fam && live.find((r) => r.isFamily && r.code.toUpperCase() === fam)) || null;
}

export type CaseDefaults = {
  category: DenialCategory;
  ownerRole: OwnerRole;
  appealable: boolean;
  resubmitDays: number;
  taxonomyMatch: boolean;
};

/** What a new case takes from the taxonomy, with the org default deadline when the code gives none. */
export function caseDefaults(
  code: string | null | undefined,
  table: readonly DenialCodeRow[],
  defaultResubmitDays: number,
): CaseDefaults {
  const row = lookupDenialCode(code, table);
  return {
    category: row?.category ?? "other",
    ownerRole: row?.defaultOwnerRole ?? "insurance",
    appealable: row?.appealable ?? true,
    resubmitDays: row?.resubmitDays ?? defaultResubmitDays,
    taxonomyMatch: !!row,
  };
}

/** Resubmission deadline = the denial date plus the code's window. */
export function deadlineFor(deniedOn: string, resubmitDays: number): string | null {
  return addDays(deniedOn, resubmitDays);
}

export type DeadlineState = "ok" | "soon" | "overdue";

export function deadlineCountdown(
  deadlineOn: string,
  today: string,
  warnDays: number,
): { state: DeadlineState; daysLeft: number; label: string } {
  const days = daysUntil(deadlineOn, today) ?? 0;
  if (days < 0)
    return {
      state: "overdue",
      daysLeft: days,
      label: days === -1 ? "1 day overdue" : `${-days} days overdue`,
    };
  const label = days === 0 ? "Due today" : days === 1 ? "1 day left" : `${days} days left`;
  return { state: days <= warnDays ? "soon" : "ok", daysLeft: days, label };
}

export const CASE_STATUSES = [
  "open",
  "in_progress",
  "appealed",
  "resubmitted",
  "won",
  "lost",
  "written_off",
  "recovered",
  "cancelled",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ACTIVE_STATUSES: readonly CaseStatus[] = [
  "open",
  "in_progress",
  "appealed",
  "resubmitted",
];
export const isActive = (s: string) => (ACTIVE_STATUSES as readonly string[]).includes(s);

export const STATUS_LABELS: Record<CaseStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  appealed: "Appealed",
  resubmitted: "Resubmitted",
  won: "Won",
  lost: "Lost",
  written_off: "Written off",
  recovered: "Recovered",
  cancelled: "Cancelled",
};

const TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  open: ["in_progress", "appealed", "resubmitted", "lost", "written_off", "cancelled"],
  in_progress: ["open", "appealed", "resubmitted", "lost", "written_off", "cancelled"],
  appealed: ["in_progress", "resubmitted", "won", "lost", "written_off"],
  resubmitted: ["in_progress", "won", "lost", "written_off"],
  won: [],
  lost: [],
  written_off: [],
  recovered: [],
  cancelled: [],
};

export function canMoveCase(from: CaseStatus, to: CaseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
export const nextCaseStatuses = (from: CaseStatus) => TRANSITIONS[from];

/** Closing a case (won, lost, written off, cancelled) needs a short written reason. */
export function closeNeedsNote(to: CaseStatus): boolean {
  return !isActive(to);
}

export type ReminderRow = {
  id: string;
  status: string;
  deadline_on: string;
  deadline_notified_at: string | null;
  appealable?: boolean;
};

/** Cases still being worked (open or in progress) whose deadline is within the warning window or past, not yet reminded. */
export function dueForDeadlineReminder<T extends ReminderRow>(
  cases: readonly T[],
  today: string,
  warnDays: number,
): T[] {
  return cases.filter((c) => {
    if (c.deadline_notified_at) return false;
    if (c.status !== "open" && c.status !== "in_progress") return false;
    const days = daysUntil(c.deadline_on, today);
    return days !== null && days <= warnDays;
  });
}
