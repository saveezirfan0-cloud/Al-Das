/**
 * Unite base (app7QJ2pvhADHQeBP) → table "Unite" (tbl9856qJP9S7OEqB): the
 * de-facto patient master. Keyed by FIELD ID (names change, ids don't); the
 * names in comments are from docs/audit/airtable-schema.md on 8 Oct 2026.
 *
 * Formulas, lookups, rollups and counts are skipped (recomputed in SQL later).
 * Visit-derived fields (first/last visit, doctor, clinic, department) are
 * stored as provisional custom fields until Phase 6 imports visits.
 */
import { parseLooseDate } from "@/lib/contacts/custom-values";
import { normalizeGender } from "@/lib/contacts/fields";
import { normalizePhone } from "@/lib/phone";

import { emptyContact, splitName, str, type MappedPatient, type PatientMapper } from "./types";

export const F = {
  patientName: "fldcF6Tlh1q8SYNsI", // Patient Name
  patientPin: "fldGW2uKUvJ8Go98Q", // Patient Pin (Unite id)
  sanoflowContactId: "fldm649QE0vG2RxkG", // Sanoflow Contact Id
  phone: "flddF5X0a7DtDJRNf", // Phone (971-5xxxxxxx)
  email: "fldikPNTGpc52GqOW", // Email
  nationalityText: "fldWCINbQSFZUrBBd", // Nationality -t
  nationalitySelect: "fldb5otM9QGYPGcfY", // Nationality -t copy (single select)
  gender: "fldXgsBUYTP2xvUv1", // Gender F/M/U
  dob: "fld1Zt1g7IGjk2mOX", // DOB
  address: "fldluzXiKHaK4RfaW", // Address
  firstVisit: "fldZHFmhmfL6INxWR", // First Visit Date
  lastVisit: "fldwTnnvCipJeVvco", // Last Visit Date
  drName: "fld0rZhF2bjTxyiNS", // Dr. Name
  clinic: "fldsA7v4aGIVzv0S8", // Clinic (select)
  departmentText: "fldHk1eGk61Hqr3yB", // Department
  departmentSelect: "fldFH9a3OL0fGEqNu", // Department copy (select)
  insurancePlan: "fldsXPzDxNdHqwET8", // Insurance Plan (Mednet / AXA)
  sanoId: "fldKENME489G7LCbC", // Sano Id (Yes / No / NF)
  // Campaign / recall send-state flags → external_refs.meta
  birthdayMessage: "fldRoTvJFjvyGiPIK",
  birthdayOffer: "fldL02KcYhX8DUbpY",
  annualCheckupReminder: "fldrEBcMdlyc2wD1Q",
  papSmearReminder: "fldnjiYH4flVeGtJ9",
  annualDental: "fldPTE2UPWTwh9E6l",
  skinCancerScreening: "fldOmR7MIOAPc6Vac",
  colonoscopyScreening: "fldCO5R7Dm4KnI2O9",
  preMenopause: "fldE9tH7TLFk52XKa",
  menopause: "fldUPXnKkW8PvMntH",
  dormantReactivation: "fld6pcu9FExk8aDyA",
  chronicRecallSentOn: "fldGJULCGakWZOt5S",
  chronicRecallCondition: "flduLqrsCl6CvaHec",
  chronicStatus: "fld0NR4XBFjQG6D4j",
  sixtyDays: "fldXbiS53VgVfJaq3",
  nmdr25: "flddCd5RFHVjD4uwb",
} as const;

const CLINICS = [
  { value: "golden_mile", label: "Al Das Medical Clinic - Golden Mile" },
  { value: "meadows", label: "Al Das Medical Clinic - Meadows" },
  { value: "palm_jumeirah", label: "Al Das Medical Clinic - Palm Jumeirah" },
];

function dateOrNull(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : parseLooseDate(s);
}

export const unitePatientsMapper: PatientMapper = {
  baseId: "app7QJ2pvhADHQeBP",
  tableId: "tbl9856qJP9S7OEqB",
  name: "Unite / Unite (patients)",
  fieldIds: Object.values(F),
  customFields: [
    { key: "address", label: "Address", type: "text" },
    {
      key: "insurance_plan",
      label: "Insurance plan",
      type: "select",
      options: [
        { value: "mednet", label: "Mednet" },
        { value: "axa", label: "AXA" },
      ],
    },
    { key: "clinic", label: "Clinic (Unite)", type: "select", options: CLINICS },
    { key: "department", label: "Department (Unite)", type: "text" },
    { key: "doctor_name", label: "Doctor (Unite)", type: "text" },
    { key: "first_visit_date", label: "First visit (Unite)", type: "date" },
    { key: "last_visit_date", label: "Last visit (Unite)", type: "date" },
  ],
  map(record): MappedPatient {
    const f = record.fields;
    const warnings: string[] = [];
    const contact = emptyContact();
    const { first, last } = splitName(str(f[F.patientName]));
    contact.first_name = first;
    contact.last_name = last;
    contact.external_id = str(f[F.patientPin]) || null;

    const rawPhone = str(f[F.phone]);
    if (rawPhone) {
      const norm = normalizePhone(rawPhone);
      if (norm) {
        contact.phone_e164 = norm.e164;
        contact.country = norm.country;
      } else warnings.push("invalid phone");
    }
    const email = str(f[F.email]).toLowerCase();
    if (email) {
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) contact.email = email;
      else warnings.push("invalid email");
    }
    contact.nationality = str(f[F.nationalitySelect]) || str(f[F.nationalityText]) || null;
    const g = str(f[F.gender]);
    contact.gender = g ? (normalizeGender(g) ?? "unknown") : null;
    contact.dob = dateOrNull(f[F.dob]);
    if (str(f[F.dob]) && !contact.dob) warnings.push("invalid dob");

    const custom: Record<string, unknown> = {};
    const address = str(f[F.address]);
    if (address) custom.address = address;
    const plan = str(f[F.insurancePlan]).toLowerCase();
    if (plan === "mednet" || plan === "axa") custom.insurance_plan = plan;
    const clinic = CLINICS.find((c) => c.label === str(f[F.clinic]));
    if (clinic) custom.clinic = clinic.value;
    const department = str(f[F.departmentSelect]) || str(f[F.departmentText]);
    if (department) custom.department = department;
    const doctor = str(f[F.drName]);
    if (doctor) custom.doctor_name = doctor;
    const firstVisit = dateOrNull(f[F.firstVisit]);
    if (firstVisit) custom.first_visit_date = firstVisit;
    const lastVisit = dateOrNull(f[F.lastVisit]);
    if (lastVisit) custom.last_visit_date = lastVisit;
    contact.custom = custom;

    const refs: Record<string, string> = {};
    const sano = str(f[F.sanoflowContactId]);
    if (sano) refs.sanoflow = sano;

    const flag = (id: string) => str(f[id]) || null;
    const meta = {
      birthday_message: flag(F.birthdayMessage),
      birthday_offer: flag(F.birthdayOffer),
      annual_checkup_reminder: flag(F.annualCheckupReminder),
      pap_smear_reminder: flag(F.papSmearReminder),
      annual_dental: flag(F.annualDental),
      skin_cancer_screening: flag(F.skinCancerScreening),
      colonoscopy_screening: flag(F.colonoscopyScreening),
      pre_menopause: flag(F.preMenopause),
      menopause: flag(F.menopause),
      dormant_reactivation: flag(F.dormantReactivation),
      chronic_recall_sent_on: dateOrNull(f[F.chronicRecallSentOn]),
      chronic_recall_condition: flag(F.chronicRecallCondition),
      chronic_status: flag(F.chronicStatus),
      sano_id: flag(F.sanoId),
      sixty_days: flag(F.sixtyDays),
      nmdr_25: f[F.nmdr25] === true,
    };

    return { recordId: record.id, contact, refs, meta, warnings, isTestRecord: false };
  },
};
