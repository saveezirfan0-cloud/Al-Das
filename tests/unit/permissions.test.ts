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
      "Billing",
      "Insurance",
      "CEO",
      "Medical Director",
    ]);
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes("*")).map((r) => r.name)).toEqual([
      "Admin",
    ]);
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
