/**
 * Acute Clinical Follow-Up Automation (appH2jHpsNR1nqEQ2) → "Patients"
 * (tblghX1mVYWgXvWbk). Mirrors the Unite-fed list; Patient ID = Unite PIN, so
 * most rows match an existing contact and only add consent / language.
 */
import { parseLooseDate } from "@/lib/contacts/custom-values";
import { normalizeGender } from "@/lib/contacts/fields";
import { normalizePhone } from "@/lib/phone";

import { emptyContact, splitName, str, type MappedPatient, type PatientMapper } from "./types";

export const F = {
  patientId: "fldHaQAC8l41cjJOP", // Patient ID (Unite PIN)
  fullName: "fldMsD1pVAFKrY6Ud", // Full Name
  mobile: "fldkdbQTj4yPG8jgk", // Mobile Number
  dob: "fldsO6hLu7C8XBnMD", // DOB
  gender: "fldNNrAAzH9GN927w", // Gender
  whatsappConsent: "fldOjPlY1tktSXZTE", // Consent for WhatsApp (checkbox)
  language: "fldQCxICzmkXLlrRb", // Language Preference
  isTestRecord: "fld5rbCcXG48MfDrO", // Is Test Record (checkbox)
} as const;

export const acutePatientsMapper: PatientMapper = {
  baseId: "appH2jHpsNR1nqEQ2",
  tableId: "tblghX1mVYWgXvWbk",
  name: "Acute Clinical Follow-Up / Patients",
  fieldIds: Object.values(F),
  customFields: [{ key: "is_test_record", label: "Test record", type: "boolean" }],
  map(record): MappedPatient {
    const f = record.fields;
    const warnings: string[] = [];
    const contact = emptyContact();
    const { first, last } = splitName(str(f[F.fullName]));
    contact.first_name = first;
    contact.last_name = last;
    contact.external_id = str(f[F.patientId]) || null;
    const rawPhone = str(f[F.mobile]);
    if (rawPhone) {
      const norm = normalizePhone(rawPhone);
      if (norm) {
        contact.phone_e164 = norm.e164;
        contact.country = norm.country;
      } else warnings.push("invalid phone");
    }
    const dob = str(f[F.dob]);
    contact.dob = dob ? (/^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : parseLooseDate(dob)) : null;
    if (dob && !contact.dob) warnings.push("invalid dob");
    const g = str(f[F.gender]);
    contact.gender = g ? (normalizeGender(g) ?? "unknown") : null;
    if (f[F.whatsappConsent] === true) contact.promotions_opt_in = true;
    const lang = str(f[F.language]).toLowerCase();
    if (lang)
      contact.language = lang.startsWith("ar")
        ? "ar"
        : lang.startsWith("en")
          ? "en"
          : lang.slice(0, 40);
    const isTest = f[F.isTestRecord] === true;
    contact.custom = isTest ? { is_test_record: true } : {};
    return { recordId: record.id, contact, refs: {}, meta: {}, warnings, isTestRecord: isTest };
  },
};
