import { MAX_REASON_LENGTH, REASON_STATUSES, type EnquiryStatus } from "@/lib/enquiries/constants";

export type StatusChange =
  | { ok: true; status: EnquiryStatus; lostReason: string | null; closed: boolean; reopened: boolean }
  | { ok: false; error: string };

/**
 * Validates a status transition. Lost and disqualified need a non-blank reason;
 * open and won never keep one; anything but open is "closed". Mirrors the
 * database constraints so the UI can explain instead of surfacing a check error.
 */
export function resolveStatusChange(input: {
  from: EnquiryStatus;
  to: EnquiryStatus;
  reason?: string | null;
}): StatusChange {
  const { from, to } = input;
  const reason = (input.reason ?? "").trim();
  if (REASON_STATUSES.includes(to)) {
    if (!reason) return { ok: false, error: `A reason is required to mark an enquiry ${to}.` };
    if (reason.length > MAX_REASON_LENGTH)
      return { ok: false, error: `The reason must be ${MAX_REASON_LENGTH} characters or fewer.` };
    return { ok: true, status: to, lostReason: reason, closed: true, reopened: false };
  }
  return {
    ok: true,
    status: to,
    lostReason: null,
    closed: to !== "open",
    reopened: from !== "open" && to === "open",
  };
}

export function isClosed(status: EnquiryStatus): boolean {
  return status !== "open";
}
