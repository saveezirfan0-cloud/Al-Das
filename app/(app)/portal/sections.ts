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
    label: "Sync Review",
    description:
      "Unite patients that could not be matched to a contact automatically. Link, create or dismiss.",
    read: "portal.sync_review.read",
    write: "portal.sync_review.write",
  },
  {
    href: "/portal/follow-ups",
    label: "Follow-Up Queue",
    description:
      "Visits that tripped a clinical rule, with the call outcome. Internal tasks for nurses and the call centre.",
    read: "portal.clinical_followups.read",
    write: "portal.clinical_followups.write",
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
