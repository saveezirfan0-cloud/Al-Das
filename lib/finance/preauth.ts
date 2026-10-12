import { addDays, daysUntil, expiryTaskDue } from "@/lib/documents/expiry";

/**
 * Pre-authorisation rules (pure). Dates are calendar dates (YYYY-MM-DD) in the clinic's timezone.
 */

export const PREAUTH_STATUSES = [
  "draft",
  "requested",
  "approved",
  "partially_approved",
  "denied",
  "expired",
  "cancelled",
  "used",
] as const;
export type PreauthStatus = (typeof PREAUTH_STATUSES)[number];

export const PREAUTH_LABELS: Record<PreauthStatus, string> = {
  draft: "Draft",
  requested: "Requested",
  approved: "Approved",
  partially_approved: "Partly approved",
  denied: "Denied",
  expired: "Expired",
  cancelled: "Cancelled",
  used: "Used",
};

/** Where a pre-authorisation may go from each status. Anything else is refused. */
const TRANSITIONS: Record<PreauthStatus, readonly PreauthStatus[]> = {
  draft: ["requested", "cancelled"],
  requested: ["approved", "partially_approved", "denied", "cancelled"],
  approved: ["used", "expired", "cancelled"],
  partially_approved: ["used", "expired", "cancelled"],
  denied: ["requested"],
  expired: [],
  cancelled: [],
  used: [],
};

export function canTransition(from: PreauthStatus, to: PreauthStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function nextStatuses(from: PreauthStatus): readonly PreauthStatus[] {
  return TRANSITIONS[from];
}

export const isApproved = (s: string) => s === "approved" || s === "partially_approved";

export type ApprovalInput = {
  authNumber: string | null;
  expiresOn: string | null;
  validFrom: string | null;
};

/** An approval without the payer's reference and an expiry date is refused (the table has the same check). */
export function validateApproval(input: ApprovalInput): string | null {
  if (!input.authNumber?.trim()) return "Enter the payer's authorisation number.";
  if (!input.expiresOn) return "Enter the date the authorisation expires.";
  if (input.validFrom && input.expiresOn < input.validFrom)
    return "The expiry date is before the start date.";
  return null;
}

export type ExpiryClass = "none" | "valid" | "expiring" | "expired";

/** Live state of an approved authorisation against today's date and the reminder lead time. */
export function preauthExpiry(
  status: string,
  expiresOn: string | null,
  today: string,
  leadDays: number,
): { state: ExpiryClass; daysLeft: number | null } {
  if (!isApproved(status)) return { state: "none", daysLeft: null };
  const days = daysUntil(expiresOn, today);
  if (days === null) return { state: "none", daysLeft: null };
  if (days < 0) return { state: "expired", daysLeft: days };
  return { state: days <= leadDays ? "expiring" : "valid", daysLeft: days };
}

export type ExpiryRow = {
  id: string;
  status: string;
  expires_on: string | null;
  expiry_notified_at: string | null;
};

/** Approved authorisations inside the reminder window that have not been reminded yet (not yet expired). */
export function dueForExpiryTask<T extends ExpiryRow>(
  rows: readonly T[],
  today: string,
  leadDays: number,
): T[] {
  return rows.filter((r) => {
    if (r.expiry_notified_at || !isApproved(r.status)) return false;
    const days = daysUntil(r.expires_on, today);
    return days !== null && days >= 0 && days <= leadDays;
  });
}

/** Approved authorisations whose expiry date has passed: the job marks them expired. */
export function pastExpiry<T extends ExpiryRow>(rows: readonly T[], today: string): T[] {
  return rows.filter((r) => {
    if (!isApproved(r.status)) return false;
    const days = daysUntil(r.expires_on, today);
    return days !== null && days < 0;
  });
}

export const taskDueAt = expiryTaskDue;

/** The horizon date for the candidate query (today + lead), or null for a bad date. */
export function reminderHorizon(today: string, leadDays: number): string | null {
  return addDays(today, leadDays);
}

/** Fixed task wording: identifiers, never a patient's name. */
export const PREAUTH_TASK_SUBJECT =
  "Pre-authorisation expiring: renew or confirm the service is done";
