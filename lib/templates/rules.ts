/**
 * Template lifecycle rules (Phase 4). Pure: what may be done to a template given its status.
 * Meta's own limits (confirm against current docs): an APPROVED template can be edited once per
 * 24 hours (and 10 times per 30 days); PENDING / IN_APPEAL templates cannot be edited at all.
 */

export const EDIT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING: "Pending review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  PAUSED: "Paused",
  DISABLED: "Disabled",
  IN_APPEAL: "In appeal",
  PENDING_DELETION: "Deleting",
  DELETED: "Deleted",
  LIMIT_EXCEEDED: "Limit exceeded",
  ARCHIVED: "Archived",
};

export type TemplateRow = {
  status: string;
  meta_template_id: string | null;
  archived_at: string | null;
  last_edited_at: string | null;
  needs_review: boolean;
};

/** Statuses a person can edit and resubmit. */
const EDITABLE = new Set(["DRAFT", "APPROVED", "REJECTED", "PAUSED"]);

export type Block = { ok: true } | { ok: false; reason: string };

export function canEdit(t: TemplateRow, now: number = Date.now()): Block {
  if (t.archived_at) return { ok: false, reason: "Unarchive the template before editing it." };
  if (!EDITABLE.has(t.status)) {
    return {
      ok: false,
      reason:
        t.status === "PENDING" || t.status === "IN_APPEAL"
          ? "Meta is reviewing this template. It can be edited once the review finishes."
          : `A ${STATUS_LABEL[t.status]?.toLowerCase() ?? t.status.toLowerCase()} template cannot be edited. Duplicate it instead.`,
    };
  }
  if (t.status === "APPROVED" && t.last_edited_at) {
    const wait = Date.parse(t.last_edited_at) + EDIT_COOLDOWN_MS - now;
    if (wait > 0)
      return {
        ok: false,
        reason: `Meta allows one edit to an approved template every 24 hours. Try again in about ${Math.ceil(wait / 3_600_000)} hour(s), or duplicate it.`,
      };
  }
  return { ok: true };
}

/** Fields that cannot change once a template exists on Meta. */
export function lockedFields(
  t: Pick<TemplateRow, "status" | "meta_template_id">,
): Array<"name" | "language" | "channel" | "category"> {
  if (t.status === "DRAFT" && !t.meta_template_id) return [];
  return t.status === "APPROVED"
    ? ["name", "language", "channel", "category"]
    : ["name", "language", "channel"];
}

export function canSubmit(t: TemplateRow): Block {
  if (t.archived_at) return { ok: false, reason: "Unarchive the template first." };
  if (t.needs_review)
    return {
      ok: false,
      reason: "This wording has not been reviewed yet. Check it, then mark it reviewed.",
    };
  if (
    t.status === "DRAFT" ||
    t.status === "REJECTED" ||
    t.status === "PAUSED" ||
    t.status === "APPROVED"
  )
    return { ok: true };
  return { ok: false, reason: "This template is already with Meta." };
}

/** What to do on Meta when a template is submitted: create it, or edit the existing one. */
export function submitMode(t: Pick<TemplateRow, "meta_template_id">): "create" | "edit" {
  return t.meta_template_id ? "edit" : "create";
}

export type Usage = {
  appointmentSlots: string[];
  clinicalKey: string | null;
  sendsLast30Days: number;
};

export function isInUse(u: Usage): boolean {
  return u.appointmentSlots.length > 0 || !!u.clinicalKey || u.sendsLast30Days > 0;
}

export function usageSummary(u: Usage): string[] {
  const out: string[] = [];
  if (u.appointmentSlots.length)
    out.push(`used for appointment ${u.appointmentSlots.join(", ")} messages`);
  if (u.clinicalKey) out.push(`used by the clinical rules (${u.clinicalKey})`);
  if (u.sendsLast30Days) out.push(`sent ${u.sendsLast30Days} time(s) in the last 30 days`);
  return out;
}

/** Local-only drafts that were never sent anywhere can be removed outright. */
export function canHardDelete(
  t: Pick<TemplateRow, "status" | "meta_template_id">,
  u: Usage,
): boolean {
  return t.status === "DRAFT" && !t.meta_template_id && !isInUse(u);
}

/** Appointment settings keys that point at this template id. */
export function appointmentSlotsUsing(
  templates: Record<string, string | null> | null | undefined,
  id: string,
): string[] {
  return Object.entries(templates ?? {})
    .filter(([, v]) => v === id)
    .map(([k]) => k);
}
