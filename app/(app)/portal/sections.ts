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
];
