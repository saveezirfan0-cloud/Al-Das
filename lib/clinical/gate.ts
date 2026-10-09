/**
 * R-26 / R-27: may a clinical message reach this contact? Pure; the caller supplies the facts.
 *
 *  1. The org gate (clinical_messaging_enabled, signed off) is closed → suppressed_gate, always.
 *  2. The template is not clinically approved → blocked.
 *  3. The contact has not given clinical-messaging consent → blocked.
 *  4. Send mode "test": only internal validation people (test records) receive anything.
 *     Send mode "live": test records never receive anything (they can't be sent to live).
 */
export type SendDecision = {
  allow: boolean;
  status: "send" | "suppressed_gate" | "suppressed_test_record" | "blocked";
  reason: string;
};

export function decideClinicalSend(i: {
  gateEnabled: boolean;
  sendMode: "test" | "live";
  contactIsTestRecord: boolean;
  templateApproved: boolean;
  hasConsent: boolean;
}): SendDecision {
  if (!i.gateEnabled)
    return { allow: false, status: "suppressed_gate", reason: "clinical_messaging_not_signed_off" };
  if (!i.templateApproved)
    return { allow: false, status: "blocked", reason: "template_not_clinically_approved" };
  if (!i.hasConsent)
    return { allow: false, status: "blocked", reason: "no_clinical_messaging_consent" };
  if (i.sendMode === "test" && !i.contactIsTestRecord)
    return {
      allow: false,
      status: "suppressed_test_record",
      reason: "test_mode_internal_numbers_only",
    };
  if (i.sendMode === "live" && i.contactIsTestRecord)
    return { allow: false, status: "suppressed_test_record", reason: "test_record_never_live" };
  return { allow: true, status: "send", reason: "ok" };
}
