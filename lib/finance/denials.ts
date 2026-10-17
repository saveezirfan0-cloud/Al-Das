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
 * Where a rejection came from and whether the clinic could have prevented it, by the code's category. PROPOSED mapping, to
 * be confirmed by the insurance case sessions (docs/47). `avoidable` is null when the category cannot say, never a guess.
 */
export type RejectionOrigin = "front_desk" | "clinical" | "billing" | "payer" | "unknown";
export const REJECTION_ORIGIN: Record<
  DenialCategory,
  { origin: RejectionOrigin; avoidable: boolean | null }
> = {
  authorization: { origin: "front_desk", avoidable: true },
  eligibility: { origin: "front_desk", avoidable: true },
  medical_necessity: { origin: "clinical", avoidable: false },
  coding: { origin: "billing", avoidable: true },
  documentation: { origin: "clinical", avoidable: true },
  duplicate: { origin: "billing", avoidable: true },
  timely_filing: { origin: "billing", avoidable: true },
  pricing: { origin: "payer", avoidable: null },
  other: { origin: "unknown", avoidable: null },
};

/** Origin and avoidable flag for a denial code, through the same taxonomy lookup the case uses. */
export function rejectionOrigin(
  code: string | null | undefined,
  table: readonly DenialCodeRow[],
): { origin: RejectionOrigin; avoidable: boolean | null } {
  const row = lookupDenialCode(code, table);
  return row ? REJECTION_ORIGIN[row.category] : { origin: "unknown", avoidable: null };
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
