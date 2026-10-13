/**
 * Patient data export and erasure requests: pure rules. The server action layer enforces these and the
 * database repeats the two-person rule as a CHECK constraint (privacy_requests_two_person).
 */

export type PrivacyKind = "export" | "erasure";
export type PrivacyStatus = "pending" | "approved" | "completed" | "rejected" | "cancelled";

export type PrivacyRequestLike = {
  kind: PrivacyKind;
  status: PrivacyStatus;
  requestedBy: string | null;
};

export type Verdict = { ok: true } | { ok: false; error: string };

/** A second person must decide; the requester can only cancel their own pending request. */
export function canDecide(request: PrivacyRequestLike, actorId: string): Verdict {
  if (request.status !== "pending")
    return { ok: false, error: "This request has already been decided." };
  if (request.requestedBy && request.requestedBy === actorId) {
    return { ok: false, error: "A different administrator must approve or reject your request." };
  }
  return { ok: true };
}

export function canCancel(request: PrivacyRequestLike, actorId: string): Verdict {
  if (request.status !== "pending")
    return { ok: false, error: "Only a pending request can be cancelled." };
  if (request.requestedBy !== actorId)
    return { ok: false, error: "Only the person who raised the request can cancel it." };
  return { ok: true };
}

/** Both kinds are carried out after approval, exactly once. */
export function canExecute(request: PrivacyRequestLike): Verdict {
  if (request.status !== "approved")
    return { ok: false, error: "The request must be approved before it is carried out." };
  return { ok: true };
}

/** The reason must say why, not just exist. */
export function validReason(reason: string): Verdict {
  const text = reason.trim();
  if (text.length < 5)
    return { ok: false, error: "Say why this request is being raised (at least 5 characters)." };
  if (text.length > 1000) return { ok: false, error: "Keep the reason under 1,000 characters." };
  return { ok: true };
}

export const ERASURE_RETAINED_NOTE =
  "Clinical records synced from Unite (visits, prescriptions, follow-ups, feedback, chronic conditions) are kept: they are medical records with their own retention period. They stay linked to the now-anonymous patient id.";

/** Subject-access export bundle: the sections included, in order. Counts only are stored on the request. */
export const EXPORT_SECTIONS = [
  "contact",
  "phones",
  "tags",
  "appointments",
  "enquiries",
  "tasks",
  "conversations",
  "messages",
  "timeline",
  "visits",
  "prescriptions",
  "followups",
  "feedback",
  "documents",
  "integrations",
] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];

/** Per-section row counts for the request's result column (never the data itself). */
export function exportCounts(
  bundle: Partial<Record<ExportSection, unknown>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const section of EXPORT_SECTIONS) {
    const value = bundle[section];
    out[section] = Array.isArray(value) ? value.length : value ? 1 : 0;
  }
  return out;
}
