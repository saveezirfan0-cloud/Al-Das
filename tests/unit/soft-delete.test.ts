import { describe, expect, it } from "vitest";

import { SETTINGS_PAGES, visibleSettingsPages } from "@/components/shell/settings-pages";
import {
  canOpenRecentlyDeleted,
  canRestore,
  parseSoftDeleteSignal,
  softDeleteChannelName,
  canStillRestore,
  daysLeft,
  DEFAULT_RESTORE_WINDOW_DAYS,
  deletedMessage,
  ENTITY_RULES,
  isSoftDeleteEntity,
  readRestoreWindowDays,
  restoreDeadline,
  restoreOutcomeMessage,
  restoreWindowSchema,
  SOFT_DELETE_ENTITIES,
  writeRestoreWindowDays,
} from "@/lib/soft-delete/rules";
import { compilePortalPredicate } from "@/lib/portal/query";
import { buildPortalFieldRegistry } from "@/lib/portal/filter-registry";
import { getPortalObject } from "@/lib/portal/objects";
import type { MemberLike } from "@/lib/auth/can";

const member = (permissions: string[]): MemberLike => ({
  userId: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000002",
  roleId: "00000000-0000-4000-8000-000000000003",
  status: "active",
  permissions,
});

describe("restore window setting", () => {
  it("defaults to 30 days when missing or not a number", () => {
    expect(DEFAULT_RESTORE_WINDOW_DAYS).toBe(30);
    for (const s of [null, undefined, {}, [], "x", { soft_delete: null }, { soft_delete: { restore_window_days: "45" } }])
      expect(readRestoreWindowDays(s)).toBe(30);
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: Number.NaN } })).toBe(30);
  });

  it("clamps to 1..90 and rounds, like app.restore_window_days", () => {
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: 0 } })).toBe(1);
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: -5 } })).toBe(1);
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: 365 } })).toBe(90);
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: 14.6 } })).toBe(15);
    expect(readRestoreWindowDays({ soft_delete: { restore_window_days: 60 } })).toBe(60);
  });

  it("validates writes as whole days from 1 to 90", () => {
    expect(restoreWindowSchema.safeParse(1).success).toBe(true);
    expect(restoreWindowSchema.safeParse(90).success).toBe(true);
    for (const bad of [0, 91, 7.5, Number.NaN, "30", null]) expect(restoreWindowSchema.safeParse(bad).success).toBe(false);
  });

  it("writes the window without touching other settings", () => {
    const next = writeRestoreWindowDays({ security: { dormant_days: 30 }, soft_delete: { other: true } }, 14);
    expect(next).toEqual({ security: { dormant_days: 30 }, soft_delete: { other: true, restore_window_days: 14 } });
    expect(writeRestoreWindowDays(null, 7)).toEqual({ soft_delete: { restore_window_days: 7 } });
    expect(() => writeRestoreWindowDays({}, 120)).toThrow();
  });
});

describe("days left", () => {
  const deleted = new Date("2026-11-01T10:00:00Z");

  it("counts whole days up to the deadline, rounding up", () => {
    expect(restoreDeadline(deleted, 30).toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(daysLeft(deleted, 30, deleted)).toBe(30);
    expect(daysLeft(deleted, 30, new Date("2026-11-01T10:00:01Z"))).toBe(30);
    expect(daysLeft(deleted, 30, new Date("2026-11-30T10:00:01Z"))).toBe(1);
    expect(daysLeft("2026-11-01T10:00:00Z", 1, new Date("2026-11-02T09:59:00Z"))).toBe(1);
  });

  it("is 0 once the window has passed (the nightly purge takes it)", () => {
    expect(daysLeft(deleted, 30, new Date("2026-12-01T10:00:00Z"))).toBe(0);
    expect(daysLeft(deleted, 30, new Date("2027-01-01T00:00:00Z"))).toBe(0);
    expect(canStillRestore(deleted, 30, new Date("2026-12-01T09:00:00Z"))).toBe(true);
    expect(canStillRestore(deleted, 30, new Date("2026-12-01T11:00:00Z"))).toBe(false);
    expect(daysLeft("not a date", 30, deleted)).toBe(0);
  });
});

describe("entities, permissions and messages", () => {
  it("restores each kind with the record's own manage permission", () => {
    expect(SOFT_DELETE_ENTITIES).toEqual(["contact", "enquiry", "task", "website_entry_point"]);
    expect(ENTITY_RULES.contact.restorePerms).toEqual(["contacts.manage"]);
    expect(ENTITY_RULES.enquiry.restorePerms).toEqual(["enquiries.manage", "enquiries.delete"]);
    expect(ENTITY_RULES.task.restorePerms).toEqual(["tasks.manage"]);
    expect(ENTITY_RULES.website_entry_point.restorePerms).toEqual(["portal.website_entry_points.write"]);
    // Whoever may delete an enquiry may undo it.
    expect(canRestore(member(["enquiries.delete"]), "enquiry")).toBe(true);
    expect(canRestore(member(["enquiries.manage"]), "enquiry")).toBe(true);
    expect(canRestore(member(["enquiries.view"]), "enquiry")).toBe(false);
    expect(canRestore(member(["enquiries.delete"]), "task")).toBe(false);
    expect(isSoftDeleteEntity("task")).toBe(true);
    expect(isSoftDeleteEntity("appointment")).toBe(false);
    expect(isSoftDeleteEntity(null)).toBe(false);
  });

  it("opens Recently deleted for anyone who can restore one kind, or set the window", () => {
    expect(canOpenRecentlyDeleted(member(["tasks.manage"]))).toBe(true);
    expect(canOpenRecentlyDeleted(member(["security.manage"]))).toBe(true);
    expect(canOpenRecentlyDeleted(member(["portal.*"]))).toBe(true);
    expect(canOpenRecentlyDeleted(member(["tasks.view", "contacts.view", "inbox.send"]))).toBe(false);
    expect(canOpenRecentlyDeleted({ ...member(["*"]), status: "suspended" })).toBe(false);
    const page = SETTINGS_PAGES.find((p) => p.href === "/settings/recently-deleted");
    expect(page?.section).toBe("Security & audit");
    expect(visibleSettingsPages(member(["contacts.view"])).some((p) => p.href === page?.href)).toBe(false);
    expect(visibleSettingsPages(member(["contacts.manage"])).some((p) => p.href === page?.href)).toBe(true);
  });

  it("says how long a delete can be undone", () => {
    expect(deletedMessage("task", 1, 30)).toBe(
      "Task deleted. It can be restored for 30 days from Settings, Recently deleted.",
    );
    expect(deletedMessage("contact", 3, 1)).toBe(
      "3 patients deleted. They can be restored for 1 day from Settings, Recently deleted.",
    );
    expect(deletedMessage("enquiry", 0, 30)).toBe("Nothing was deleted.");
  });

  it("maps every database answer to a message, failing closed on unknown words", () => {
    expect(restoreOutcomeMessage("task", "restored")).toEqual({ ok: true, message: "Task restored." });
    for (const w of ["expired", "conflict", "parent_deleted", "not_found", "something_else", ""])
      expect(restoreOutcomeMessage("contact", w).ok).toBe(false);
    expect(restoreOutcomeMessage("contact", "conflict").message).toMatch(/Change or remove it on that record/);
    expect(restoreOutcomeMessage("contact", "conflict").message).not.toMatch(/[Mm]erge/);
    expect(restoreOutcomeMessage("task", "parent_deleted").message).toMatch(/patient or enquiry/);
  });
});

describe("soft-delete broadcast", () => {
  const id = "11111111-1111-4111-8111-111111111111";

  it("uses one channel per org", () => {
    expect(softDeleteChannelName("org-1")).toBe("soft-delete:org-1");
  });

  it("accepts ids only and refuses anything else (the channel is untrusted)", () => {
    expect(parseSoftDeleteSignal({ entity: "task", ids: [id] })).toEqual({ entity: "task", ids: [id] });
    expect(parseSoftDeleteSignal({ entity: "task", ids: [id, "Layla", 5, null] })).toEqual({ entity: "task", ids: [id] });
    for (const bad of [null, "x", {}, { entity: "appointment", ids: [id] }, { entity: "task", ids: "x" }, { entity: "task", ids: [] }])
      expect(parseSoftDeleteSignal(bad)).toBeNull();
    expect(parseSoftDeleteSignal({ entity: "task", ids: Array(900).fill(id) })?.ids).toHaveLength(500);
  });
});

describe("portal soft delete", () => {
  it("never lists, counts or exports website entry points in the bin, and leaves other objects alone", () => {
    const web = getPortalObject("website_entry_points")!;
    expect(web.softDeleteEntity).toBe("website_entry_point");
    expect(compilePortalPredicate(web, buildPortalFieldRegistry(web), null, null).sql).toBe(
      "c.deleted_at is null",
    );
    const withSearch = compilePortalPredicate(web, buildPortalFieldRegistry(web), null, "booking");
    expect(withSearch.sql.startsWith("c.deleted_at is null and (")).toBe(true);
    const diag = getPortalObject("ref_diagnoses")!;
    expect(diag.softDeleteEntity).toBeUndefined();
    expect(compilePortalPredicate(diag, buildPortalFieldRegistry(diag), null, null).sql).toBe("true");
  });
});
