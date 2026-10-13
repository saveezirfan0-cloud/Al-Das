/**
 * Should this person be asked for a review? (pure)
 *
 * The rules are about consent and care for the person, never about how the visit went. Google's policy forbids "review
 * gating" (asking only the happy patients, or steering unhappy ones elsewhere), so this function has NO input about
 * sentiment, complaints, AI tags or satisfaction, and a test checks that it stays that way. The only reasons not to ask:
 *
 *   not opted in / stop marketing        the person did not agree to messages like this (WhatsApp error 131050 sets stop_marketing)
 *   do not ask                           staff switch: deceased, a placeholder record, asked not to be asked
 *   test, erased, deleted, merged        records that are not a real, current patient
 *   training workspace                   decided by the caller (nothing leaves a training workspace)
 *   no link, no way to reach, visit not completed any more, too late
 *
 * The per-person cap is NOT decided here: it is claimed atomically in the database (claim_review_request).
 */
export type ReviewSkipReason =
  | "integration_off"
  | "training"
  | "visit_not_completed"
  | "no_patient"
  | "patient_unavailable"
  | "do_not_ask"
  | "test_record"
  | "no_opt_in"
  | "stop_marketing"
  | "no_recipient"
  | "no_link"
  | "template_not_ready"
  | "no_channel"
  | "too_late"
  | "queue_failed";

export const REVIEW_REASON_LABEL: Record<ReviewSkipReason | "cap", string> = {
  integration_off: "Switched off",
  training: "Training workspace",
  visit_not_completed: "Visit no longer completed",
  no_patient: "No patient on the visit",
  patient_unavailable: "Record erased, deleted or merged",
  do_not_ask: "Marked 'do not ask'",
  test_record: "Test record",
  no_opt_in: "No marketing opt-in",
  stop_marketing: "Asked to stop marketing",
  no_recipient: "No WhatsApp number or user id",
  no_link: "No review link for the location",
  template_not_ready: "Template not ready",
  no_channel: "No active WhatsApp number",
  too_late: "Too long after the visit",
  queue_failed: "Could not be queued",
  cap: "Already asked recently",
};

export type PersonFacts = {
  deleted_at?: string | null;
  erased_at?: string | null;
  merged_into_id?: string | null;
  is_test_record?: boolean | null;
  no_review_requests_at?: string | null;
  promotions_opt_in?: boolean | null;
  stop_marketing?: boolean | null;
};

export type ReviewDecisionInput = {
  appointment: {
    status: string;
    checkin_status: string | null;
    hasPatient: boolean;
  };
  /** The patient the visit belongs to. */
  patient: PersonFacts | null;
  /** The person the message goes to (the guardian of a dependant, otherwise the patient). Null when nobody can be reached. */
  recipient: PersonFacts | null;
  /** The location's validated review link, or null. */
  link: string | null;
  now: Date;
  visitEndedAt: Date;
  maxAgeMs: number;
};

export type ReviewDecision = { allow: true } | { allow: false; reason: ReviewSkipReason };

/** A visit counts as finished when it is Completed, or the front desk checked the patient out. */
export function visitIsFinished(a: { status: string; checkin_status: string | null }): boolean {
  if (a.status === "cancelled" || a.status === "no_show") return false;
  return a.status === "completed" || a.checkin_status === "checked_out";
}

function unavailable(p: PersonFacts): boolean {
  return !!(p.deleted_at || p.erased_at || p.merged_into_id);
}

export function reviewDecision(i: ReviewDecisionInput): ReviewDecision {
  if (!visitIsFinished(i.appointment)) return { allow: false, reason: "visit_not_completed" };
  if (!i.appointment.hasPatient || !i.patient) return { allow: false, reason: "no_patient" };
  if (unavailable(i.patient)) return { allow: false, reason: "patient_unavailable" };
  if (i.patient.no_review_requests_at) return { allow: false, reason: "do_not_ask" };
  if (i.patient.is_test_record) return { allow: false, reason: "test_record" };
  if (!i.recipient) return { allow: false, reason: "no_recipient" };
  if (unavailable(i.recipient)) return { allow: false, reason: "patient_unavailable" };
  if (i.recipient.no_review_requests_at) return { allow: false, reason: "do_not_ask" };
  if (i.recipient.is_test_record) return { allow: false, reason: "test_record" };
  // Consent belongs to the person who is messaged; a patient who stopped marketing is respected even when a guardian is messaged.
  if (i.patient.stop_marketing || i.recipient.stop_marketing)
    return { allow: false, reason: "stop_marketing" };
  if (i.recipient.promotions_opt_in !== true) return { allow: false, reason: "no_opt_in" };
  if (!i.link) return { allow: false, reason: "no_link" };
  if (i.now.getTime() - i.visitEndedAt.getTime() > i.maxAgeMs)
    return { allow: false, reason: "too_late" };
  return { allow: true };
}
