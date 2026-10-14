/** Portal sections. A member sees a section when they hold its read permission (portal.* covers all). */
export type PortalSection = {
  href: string;
  label: string;
  description: string;
  read: string;
  write: string;
};

export const PORTAL_SECTIONS: readonly PortalSection[] = [
  {
    href: "/portal/sync-review",
    label: "Sync review",
    description:
      "Unite patients that could not be matched to a contact automatically. Link, create or dismiss.",
    read: "portal.sync_review.read",
    write: "portal.sync_review.write",
  },
  {
    href: "/portal/follow-ups",
    label: "Clinical follow-ups",
    description:
      "Visits that tripped a clinical rule, with the call outcome. Internal tasks for nurses and the call centre.",
    read: "portal.clinical_followups.read",
    write: "portal.clinical_followups.write",
  },
  {
    href: "/portal/clinical-feedback",
    label: "Clinical feedback",
    description:
      "Patient replies to clinical check-ins: score, side effects, red flags and whether the doctor and coordinator were told.",
    read: "portal.clinical_followups.read",
    write: "portal.clinical_feedback.write",
  },
  {
    href: "/portal/data-quality",
    label: "Data quality",
    description:
      "Visits with missing vitals or no matched patient, and diagnosis codes Pulse does not know. The rules cannot judge these.",
    read: "portal.clinical_visits.read",
    write: "portal.clinical_visits.read",
  },
  {
    href: "/portal/unclassified-medications",
    label: "Unclassified medications",
    description:
      "Unite medication codes with no class yet. No antibiotic sequence uses them until a clinician classifies them.",
    read: "portal.clinical_visits.read",
    write: "portal.medication_classes.write",
  },
  {
    href: "/portal/clinical-settings",
    label: "Clinical settings",
    description:
      "The thresholds the clinical rules use, with sign-off. Nothing fires on an unsigned value, and patient messaging stays off until signed.",
    read: "portal.clinical_settings.read",
    write: "clinical.settings.manage",
  },
];
