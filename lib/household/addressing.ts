/**
 * Who a patient's appointment message goes to (pure).
 *
 * A dependant (usually a child) has no WhatsApp number of their own: the message goes to the guardian's number
 * and has to name the patient, otherwise a parent of three cannot tell whose appointment it is.
 */
export type HouseholdContact = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone_e164: string | null;
  wa_bsuid: string | null;
  stop_marketing?: boolean | null;
};

export type HouseholdLink = {
  guardian: HouseholdContact;
  reminders_to_guardian: boolean;
};

const hasIdentifier = (c: Pick<HouseholdContact, "phone_e164" | "wa_bsuid">) =>
  !!(c.phone_e164 || c.wa_bsuid);

export type Recipient = {
  /** The contact whose number/user id the message is sent to (and whose conversation carries it). */
  recipient: HouseholdContact;
  /** The patient the appointment belongs to. */
  patient: HouseholdContact;
  viaGuardian: boolean;
};

/**
 * The guardian receives the message when the link says so, or when the patient has nothing to receive it on.
 * A guardian with no usable number falls back to the patient's own, and finally to "nobody" (null), so the
 * failure is reported instead of the message going astray.
 */
export function resolveRecipient(
  patient: HouseholdContact,
  link: HouseholdLink | null,
): Recipient | null {
  if (
    link &&
    (link.reminders_to_guardian || !hasIdentifier(patient)) &&
    hasIdentifier(link.guardian)
  ) {
    return { recipient: link.guardian, patient, viaGuardian: true };
  }
  if (hasIdentifier(patient)) return { recipient: patient, patient, viaGuardian: false };
  return null;
}

type NameParts = { first_name: string | null; last_name: string | null };

const firstOf = (c: Pick<NameParts, "first_name">) =>
  (c.first_name ?? "").trim().split(/\s+/)[0] ?? "";
const fullOf = (c: NameParts) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim();

/**
 * Name values for a template. `contact.*` is the person the message is written to. For a household message that
 * is the guardian, rendered "Layla (for Omar)" so that a template written as "Hello {{1}}" still names the
 * patient. A template that maps `patient.first_name` / `patient.name` itself (explicitPatientVariable) gets the
 * plain guardian name in `contact.*` and the patient's name where it asked for it.
 */
export function householdNameValues(input: {
  patient: NameParts;
  guardian: NameParts | null;
  explicitPatientVariable: boolean;
}): Record<string, string> {
  const patientFirst = firstOf(input.patient) || "the patient";
  const patientName = fullOf(input.patient) || patientFirst;
  const out: Record<string, string> = {
    "patient.first_name": patientFirst,
    "patient.name": patientName,
    // Without a guardian "the person we write to" is the patient, so a template mapped to it still reads well.
    "guardian.first_name": input.guardian ? firstOf(input.guardian) || "there" : patientFirst,
  };
  if (!input.guardian) return out;
  const guardianFirst = firstOf(input.guardian) || "there";
  const guardianName = fullOf(input.guardian) || guardianFirst;
  out["contact.first_name"] = input.explicitPatientVariable
    ? guardianFirst
    : `${guardianFirst} (for ${patientFirst})`;
  out["contact.name"] = input.explicitPatientVariable
    ? guardianName
    : `${guardianName} (for ${patientFirst})`;
  return out;
}
