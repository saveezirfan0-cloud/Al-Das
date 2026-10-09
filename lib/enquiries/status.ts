/**
 * Enquiry status rules. Status is the outcome (open / won / lost / disqualified); the stage is the
 * position in a pipeline and is independent. Pure; unit-tested. The DB trigger
 * (app.enquiry_invariants) enforces the same closed_at / reason invariants.
 */
export const ENQUIRY_STATUSES = ["open", "won", "lost", "disqualified"] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

export const STATUS_LABELS: Record<EnquiryStatus, string> = {
  open: "Open",
  won: "Won",
  lost: "Lost",
  disqualified: "Disqualified",
};

export const REASON_MAX = 300;

export function isEnquiryStatus(v: unknown): v is EnquiryStatus {
  return typeof v === "string" && (ENQUIRY_STATUSES as readonly string[]).includes(v);
}

/** Closed = anything but open. */
export function isClosed(status: EnquiryStatus): boolean {
  return status !== "open";
}

export function requiresReason(status: EnquiryStatus): boolean {
  return status === "lost" || status === "disqualified";
}

export type StatusChange =
  | {
      ok: true;
      status: EnquiryStatus;
      /** Stored reason: only lost / disqualified carry one. */
      reason: string | null;
      changed: boolean;
      closes: boolean;
      reopens: boolean;
    }
  | { ok: false; error: string };

/**
 * Validates a status change. Lost and disqualified need a reason; others drop it. Any status can
 * move to any other (a won enquiry can be reopened). Re-applying the same status is a no-op unless
 * the reason changes.
 */
export function validateStatusChange(
  current: EnquiryStatus,
  next: EnquiryStatus,
  reason: string | null | undefined,
  currentReason: string | null = null,
): StatusChange {
  const trimmed = (reason ?? "").trim();
  if (requiresReason(next)) {
    if (!trimmed) return { ok: false, error: `Say why this enquiry is ${next}.` };
    if (trimmed.length > REASON_MAX)
      return { ok: false, error: `The reason is limited to ${REASON_MAX} characters.` };
  }
  const stored = requiresReason(next) ? trimmed : null;
  return {
    ok: true,
    status: next,
    reason: stored,
    changed: next !== current || stored !== currentReason,
    closes: !isClosed(current) && isClosed(next),
    reopens: isClosed(current) && !isClosed(next),
  };
}
