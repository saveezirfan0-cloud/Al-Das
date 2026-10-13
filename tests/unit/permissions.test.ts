import { describe, expect, it } from "vitest";

import {
  FINANCE_ROLES,
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

  it("has exactly one Admin with full access and the seed roles", () => {
    expect(SYSTEM_ROLES.map((r) => r.name)).toEqual([
      "Admin",
      "Manager",
      "Agent",
      "Receptionist",
      "Care coordinator",
      "Marketing",
      "Finance",
      "Finance Manager",
      "Billing",
      "Insurance",
      "CEO",
      "Medical Director",
      "Cost / Payroll",
      "Department head",
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
    expect(perms("Manager")).toEqual(
      expect.arrayContaining(["ai.use", "kb.manage", "reports.export"]),
    );
    expect(perms("Agent")).toContain("ai.use");
    expect(perms("Receptionist")).toContain("ai.use");
    // Agents can use AI but never manage the knowledge base or export reports.
    expect(perms("Agent")).not.toContain("kb.manage");
    expect(perms("Agent")).not.toContain("reports.export");
    // Marketing has reports but exporting them is a deliberate, separate grant.
    expect(perms("Marketing")).not.toContain("reports.export");
  });

  it("keeps clinical sign-off out of every preset except Admin (explicit grant only)", () => {
    const signers = SYSTEM_ROLES.filter((r) =>
      r.permissions.some((p) => permissionMatches(p, "clinical.settings.manage")),
    ).map((r) => r.name);
    expect(signers).toEqual(["Admin"]);
    // the care coordinator works the queue but cannot approve the thresholds
    const cc = SYSTEM_ROLES.find((r) => r.name === "Care coordinator")!;
    expect(
      cc.permissions.some((p) => permissionMatches(p, "portal.clinical_followups.write")),
    ).toBe(true);
  });

  it("finance presets: billing cannot see claims, insurance cannot see invoices, only admins hold capture/reference rights by default", () => {
    const perms = (name: string) => FINANCE_ROLES.find((r) => r.name === name)?.permissions ?? [];
    expect(perms("Billing")).not.toContain("finance.claims.view");
    expect(perms("Insurance")).not.toContain("finance.invoices.view");
    expect(perms("Insurance")).toContain("finance.claims.import");
    for (const r of FINANCE_ROLES) expect(r.permissions).not.toContain("finance.capture.manage");
    expect(perms("Finance")).toContain("finance.reference.manage");
  });
});

describe("Phase 15 permissions", () => {
  it("catalogues security.manage and privacy.manage in their own group", () => {
    for (const key of ["security.manage", "privacy.manage"]) {
      const entry = PERMISSIONS.find((p) => p.key === key);
      expect(entry, key).toBeDefined();
      expect(entry?.group).toBe("Security & privacy");
    }
  });
  it("gives them to Admin only: every preset role stays without them, and '*' covers them", () => {
    for (const role of SYSTEM_ROLES) {
      if (role.permissions.includes("*")) continue;
      expect(role.permissions, role.name).not.toContain("security.manage");
      expect(role.permissions, role.name).not.toContain("privacy.manage");
    }
    expect(permissionMatches("*", "security.manage")).toBe(true);
    expect(permissionMatches("settings.manage", "security.manage")).toBe(false);
    expect(permissionMatches("settings.manage", "privacy.manage")).toBe(false);
  });
});

describe("Phase 16 permissions", () => {
  const perms = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;

  it("catalogues the four keys in their own group", () => {
    for (const key of ["media.view", "media.manage", "documents.view", "documents.manage"]) {
      const entry = PERMISSIONS.find((p) => p.key === key);
      expect(entry, key).toBeDefined();
      expect(entry?.group).toBe("Media & documents");
    }
  });

  it("does not let contacts.* or inbox rights open patient documents", () => {
    for (const granted of [
      "contacts.view",
      "contacts.manage",
      "contacts.export",
      "inbox.view_all",
      "inbox.send",
      "portal.*",
      "settings.manage",
    ]) {
      expect(permissionMatches(granted, "documents.view"), granted).toBe(false);
      expect(permissionMatches(granted, "documents.manage"), granted).toBe(false);
    }
    expect(permissionMatches("*", "documents.view")).toBe(true);
  });

  it("gives patient documents to the front desk and care team, never to Agent, Marketing or the finance roles", () => {
    for (const name of ["Manager", "Receptionist", "Care coordinator"]) {
      expect(perms(name), name).toEqual(
        expect.arrayContaining(["documents.view", "documents.manage"]),
      );
    }
    for (const name of [
      "Agent",
      "Marketing",
      "Finance",
      "Billing",
      "Insurance",
      "CEO",
      "Medical Director",
    ]) {
      expect(perms(name), name).not.toContain("documents.view");
      expect(perms(name), name).not.toContain("documents.manage");
    }
  });

  it("lets Marketing and Manager manage the library; Agent and Receptionist only pick from it", () => {
    expect(perms("Marketing")).toEqual(expect.arrayContaining(["media.view", "media.manage"]));
    expect(perms("Manager")).toEqual(expect.arrayContaining(["media.view", "media.manage"]));
    for (const name of ["Agent", "Receptionist", "Care coordinator"]) {
      expect(perms(name)).toContain("media.view");
      expect(perms(name)).not.toContain("media.manage");
    }
  });
});
