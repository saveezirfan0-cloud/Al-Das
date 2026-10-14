import { can, type MemberLike } from "@/lib/auth/can";

import { SOFT_DELETE_ENTITIES, type SoftDeleteEntity } from "./signal";

/**
 * Who may restore what (docs/35_SOFT_DELETE_NOTES.md). Kept free of Zod so the Settings menu (a browser module) can
 * use canOpenRecentlyDeleted without it; rules.ts re-exports this.
 *
 * What each kind of record is called, and the permissions that may restore it: the record's own manage key, plus (for
 * enquiries) the separate delete key, since whoever may delete may undo it. Any one of them is enough.
 */
export const ENTITY_RULES: Record<
  SoftDeleteEntity,
  { label: string; plural: string; restorePerms: readonly string[]; auditEntity: string }
> = {
  contact: {
    label: "Contact",
    plural: "contacts",
    restorePerms: ["contacts.manage"],
    auditEntity: "contact",
  },
  enquiry: {
    label: "Enquiry",
    plural: "enquiries",
    restorePerms: ["enquiries.manage", "enquiries.delete"],
    auditEntity: "enquiry",
  },
  task: { label: "Task", plural: "tasks", restorePerms: ["tasks.manage"], auditEntity: "task" },
  website_entry_point: {
    label: "Website entry point",
    plural: "website entry points",
    restorePerms: ["portal.website_entry_points.write"],
    auditEntity: "website_entry_points",
  },
};

/** May this member restore (and so see in Recently deleted) this kind of record? */
export function canRestore(member: MemberLike | null | undefined, entity: SoftDeleteEntity): boolean {
  return ENTITY_RULES[entity].restorePerms.some((p) => can(member, p));
}

/** Who may open Settings, Recently deleted: anyone who can restore one kind of record, or set the window. */
export function canOpenRecentlyDeleted(member: MemberLike | null | undefined): boolean {
  return can(member, "security.manage") || SOFT_DELETE_ENTITIES.some((e) => canRestore(member, e));
}
