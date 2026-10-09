import { describe, expect, it } from "vitest";

import {
  PERMISSION_KEYS,
  PERMISSIONS,
  permissionMatches,
  SYSTEM_ROLES,
} from "@/lib/auth/permissions";

describe("permissionMatches", () => {
  it("matches exact keys and the global wildcard", () => {
    expect(permissionMatches("inbox.send", "inbox.send")).toBe(true);
    expect(permissionMatches("*", "anything.at.all")).toBe(true);
    expect(permissionMatches("inbox.send", "inbox.view_all")).toBe(false);
  });

  it("supports trailing wildcards at any depth", () => {
    expect(permissionMatches("portal.*", "portal.claims.read")).toBe(true);
    expect(permissionMatches("portal.*", "portal.claims.write")).toBe(true);
    expect(permissionMatches("portal.*", "portal")).toBe(false);
    expect(permissionMatches("portal.*", "reports.view")).toBe(false);
  });

  it("supports single-segment wildcards", () => {
    expect(permissionMatches("portal.*.read", "portal.claims.read")).toBe(true);
    expect(permissionMatches("portal.*.read", "portal.claims.write")).toBe(false);
    expect(permissionMatches("portal.*.read", "portal.read")).toBe(false);
    expect(permissionMatches("portal.*.read", "portal.a.b.read")).toBe(false);
  });

  it("never matches a longer requested key against a shorter exact grant", () => {
    expect(permissionMatches("portal", "portal.claims.read")).toBe(false);
  });
});

describe("catalogue", () => {
  it("has unique keys", () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSIONS.length);
  });

  it("system roles only use catalogue keys (or '*')", () => {
    for (const role of SYSTEM_ROLES) {
      for (const p of role.permissions) {
        expect(p === "*" || PERMISSION_KEYS.includes(p), `${role.name}: ${p}`).toBe(true);
      }
    }
  });

  it("has exactly one Admin with full access and the five seed roles", () => {
    expect(SYSTEM_ROLES.map((r) => r.name)).toEqual([
      "Admin",
      "Manager",
      "Agent",
      "Receptionist",
      "Marketing",
    ]);
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes("*")).map((r) => r.name)).toEqual([
      "Admin",
    ]);
  });

  it("grants the Phase 10 keys to the right system roles", () => {
    const perms = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;
    for (const key of ["ai.use", "kb.manage", "reports.export"]) {
      expect(PERMISSION_KEYS).toContain(key);
    }
    expect(perms("Manager")).toEqual(expect.arrayContaining(["ai.use", "kb.manage", "reports.export"]));
    expect(perms("Agent")).toContain("ai.use");
    expect(perms("Receptionist")).toContain("ai.use");
    // Agents can use AI but never manage the knowledge base or export reports.
    expect(perms("Agent")).not.toContain("kb.manage");
    expect(perms("Agent")).not.toContain("reports.export");
    // Marketing has reports but exporting them is a deliberate, separate grant.
    expect(perms("Marketing")).not.toContain("reports.export");
  });
});
