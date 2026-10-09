/** Builds /templates URLs that keep the list filters while drawers open and close. */
export function templatesHref(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "" || v === "all" || (k === "page" && v === 1))
      continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `/templates?${qs}` : "/templates";
}

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PAUSED: "Paused",
  DISABLED: "Disabled",
  FLAGGED: "Flagged",
  IN_APPEAL: "In appeal",
  LIMIT_EXCEEDED: "Limit exceeded",
  LOCKED: "Locked",
  REINSTATED: "Reinstated",
  PENDING_DELETION: "Pending deletion",
  ARCHIVED: "Archived",
  DELETED: "Deleted",
};
