import { describe, expect, it } from "vitest";

import { isAssignablePermission, SYSTEM_ROLES } from "@/lib/auth/permissions";
import { requirePortalObject } from "@/lib/portal/objects";
import {
  canReadObject,
  canWriteObject,
  isPortalPermissionKey,
  readableObjects,
} from "@/lib/portal/permissions";

const role = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!;
const member = (perms: string[], status = "active") => ({ permissions: perms, status });

describe("portal permissions", () => {
  const diag = requirePortalObject("ref_diagnoses");
  const classes = requirePortalObject("ref_medication_classes");

  it("Manager (portal.*) reads and writes every object", () => {
    const m = member(role("Manager").permissions);
    for (const o of [diag, classes]) {
      expect(canReadObject(m, o)).toBe(true);
      expect(canWriteObject(m, o)).toBe(true);
    }
  });

  it("medication classes use the stricter clinical read key, matching the table's RLS", () => {
    expect(classes.readPerm).toBe("portal.clinical_visits.read");
    expect(canReadObject(member(["portal.ref_medication_classes.read"]), classes)).toBe(false);
    expect(canReadObject(member(["portal.clinical_visits.read"]), classes)).toBe(true);
    expect(canWriteObject(member(["portal.medication_classes.write"]), classes)).toBe(true);
  });

  it("Agent / Receptionist (portal.*.read) read only", () => {
    for (const n of ["Agent", "Receptionist"]) {
      const m = member(role(n).permissions);
      expect(canReadObject(m, diag)).toBe(true);
      expect(canWriteObject(m, diag)).toBe(false);
    }
  });

  it("Marketing sees no portal objects; Admin sees all", () => {
    expect(readableObjects(member(role("Marketing").permissions))).toHaveLength(0);
    expect(readableObjects(member(["*"])).length).toBeGreaterThan(5);
  });

  it("a per-object key grants only that object", () => {
    const m = member(["portal.ref_items.read"]);
    expect(readableObjects(m).map((o) => o.key)).toEqual(["ref_items"]);
  });

  it("suspended members and missing members have no access", () => {
    expect(canReadObject(member(["*"], "suspended"), diag)).toBe(false);
    expect(canReadObject(null, diag)).toBe(false);
  });

  it("role editor accepts per-object keys but not arbitrary ones", () => {
    expect(isAssignablePermission("portal.ref_items.write")).toBe(true);
    expect(isAssignablePermission("portal.Bad Key.read")).toBe(false);
    expect(isAssignablePermission("portal.x.delete")).toBe(false);
    expect(isAssignablePermission("billing.refund")).toBe(false);
    expect(isPortalPermissionKey("clinical.settings.manage")).toBe(true);
  });
});
