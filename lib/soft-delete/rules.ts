import { z } from "zod";

import { can, type MemberLike } from "@/lib/auth/can";

/**
 * Soft delete with a restore window (docs/35_SOFT_DELETE_NOTES.md). Pure rules shared by the server actions, the
 * "Recently deleted" page and the tests. The database repeats the window rule (app.restore_window_days) for the
 * restore check and the nightly purge; keep the two in step.
 */

export const SOFT_DELETE_ENTITIES = ["contact", "enquiry", "task", "website_entry_point"] as const;
export type SoftDeleteEntity = (typeof SOFT_DELETE_ENTITIES)[number];

export const DEFAULT_RESTORE_WINDOW_DAYS = 30;
export const MIN_RESTORE_WINDOW_DAYS = 1;
export const MAX_RESTORE_WINDOW_DAYS = 90;

/** What each kind of record is called, and the permission that may restore it (the record's own manage key). */
export const ENTITY_RULES: Record<
  SoftDeleteEntity,
  { label: string; plural: string; restorePerm: string; auditEntity: string }
> = {
  contact: {
    label: "Contact",
    plural: "contacts",
    restorePerm: "contacts.manage",
    auditEntity: "contact",
  },
  enquiry: {
    label: "Enquiry",
    plural: "enquiries",
    restorePerm: "enquiries.manage",
    auditEntity: "enquiry",
  },
  task: { label: "Task", plural: "tasks", restorePerm: "tasks.manage", auditEntity: "task" },
  website_entry_point: {
    label: "Website entry point",
    plural: "website entry points",
    restorePerm: "portal.website_entry_points.write",
    auditEntity: "website_entry_points",
  },
};

/** Who may open Settings, Recently deleted: anyone who can restore one kind of record, or set the window. */
export function canOpenRecentlyDeleted(member: MemberLike | null | undefined): boolean {
  return (
    can(member, "security.manage") ||
    SOFT_DELETE_ENTITIES.some((e) => can(member, ENTITY_RULES[e].restorePerm))
  );
}

export function isSoftDeleteEntity(v: unknown): v is SoftDeleteEntity {
  return typeof v === "string" && (SOFT_DELETE_ENTITIES as readonly string[]).includes(v);
}

export const restoreWindowSchema = z
  .number({ error: "Enter a number of days" })
  .int("Use whole days")
  .min(MIN_RESTORE_WINDOW_DAYS, `At least ${MIN_RESTORE_WINDOW_DAYS} day`)
  .max(MAX_RESTORE_WINDOW_DAYS, `At most ${MAX_RESTORE_WINDOW_DAYS} days`);

/**
 * The org's restore window from orgs.settings.soft_delete.restore_window_days. Same rule as the database: a number is
 * rounded and clamped to 1..90; anything else (missing, text, null) means the 30-day default.
 */
export function readRestoreWindowDays(orgSettings: unknown): number {
  const root =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? (orgSettings as Record<string, unknown>).soft_delete
      : undefined;
  const raw =
    root && typeof root === "object" && !Array.isArray(root)
      ? (root as Record<string, unknown>).restore_window_days
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_RESTORE_WINDOW_DAYS;
  return Math.min(MAX_RESTORE_WINDOW_DAYS, Math.max(MIN_RESTORE_WINDOW_DAYS, Math.round(raw)));
}

/** Returns new org settings with the window set; other settings are kept. Throws on an invalid value. */
export function writeRestoreWindowDays(orgSettings: unknown, days: number): Record<string, unknown> {
  const valid = restoreWindowSchema.parse(days);
  const base =
    orgSettings && typeof orgSettings === "object" && !Array.isArray(orgSettings)
      ? { ...(orgSettings as Record<string, unknown>) }
      : {};
  const prev =
    base.soft_delete && typeof base.soft_delete === "object" && !Array.isArray(base.soft_delete)
      ? (base.soft_delete as Record<string, unknown>)
      : {};
  base.soft_delete = { ...prev, restore_window_days: valid };
  return base;
}

const DAY_MS = 86_400_000;

/** When the item stops being restorable. */
export function restoreDeadline(deletedAt: Date | string, windowDays: number): Date {
  const t = typeof deletedAt === "string" ? new Date(deletedAt) : deletedAt;
  return new Date(t.getTime() + windowDays * DAY_MS);
}

/**
 * Whole days left to restore, rounded up (so "less than a day" reads as 1). 0 means the window has passed and the
 * nightly purge will take it.
 */
export function daysLeft(deletedAt: Date | string, windowDays: number, now: Date = new Date()): number {
  const ms = restoreDeadline(deletedAt, windowDays).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

export function canStillRestore(
  deletedAt: Date | string,
  windowDays: number,
  now: Date = new Date(),
): boolean {
  return daysLeft(deletedAt, windowDays, now) > 0;
}

/** The toast after a delete: how many went to the bin and for how long they can be restored. */
export function deletedMessage(entity: SoftDeleteEntity, n: number, windowDays: number): string {
  const r = ENTITY_RULES[entity];
  const what = n === 1 ? r.label : `${n} ${r.plural}`;
  const days = `${windowDays} day${windowDays === 1 ? "" : "s"}`;
  if (n === 0) return `Nothing was deleted.`;
  return `${what} deleted. ${n === 1 ? "It" : "They"} can be restored for ${days} from Settings, Recently deleted.`;
}

/** The words public.restore_deleted_record answers with. */
export type RestoreOutcome = "restored" | "not_found" | "expired" | "conflict" | "parent_deleted";

export function restoreOutcomeMessage(entity: SoftDeleteEntity, outcome: string): {
  ok: boolean;
  message: string;
} {
  const label = ENTITY_RULES[entity].label;
  switch (outcome) {
    case "restored":
      return { ok: true, message: `${label} restored.` };
    case "expired":
      return {
        ok: false,
        message: "The restore window has passed; this item will be removed tonight.",
      };
    case "conflict":
      return {
        ok: false,
        message:
          entity === "contact"
            ? "Another contact now uses this phone number, WhatsApp account or Unite PIN. Merge or change that contact first."
            : entity === "task"
              ? "That appointment already has an open call task. Close it first."
              : "A live record conflicts with this one.",
      };
    case "parent_deleted":
      return {
        ok: false,
        message:
          entity === "task"
            ? "Its contact or enquiry is also in Recently deleted. Restore that first."
            : "Its contact is also in Recently deleted. Restore the contact first.",
      };
    default:
      return { ok: false, message: "This item is no longer in Recently deleted." };
  }
}
