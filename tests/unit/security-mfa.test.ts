import { describe, expect, it } from "vitest";

import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import {
  isMfaExemptPath,
  isSensitivePermission,
  isSensitiveRole,
  mfaGate,
} from "@/lib/security/mfa";

describe("sensitive roles", () => {
  it("flags settings, finance, clinical and the new security keys", () => {
    for (const p of [
      "*",
      "settings.manage",
      "finance.view",
      "finance.claims.import",
      "portal.clinical_followups.read",
      "portal.clinical_visits.read",
      "security.manage",
      "privacy.manage",
      "clinical.settings.manage",
    ]) {
      expect(isSensitivePermission(p), p).toBe(true);
    }
  });
  it("flags portal wildcards because they reach clinical objects, and leaves ordinary keys alone", () => {
    expect(isSensitivePermission("portal.*")).toBe(true);
    expect(isSensitivePermission("portal.*.read")).toBe(true);
    for (const p of [
      "inbox.send",
      "contacts.view",
      "tasks.manage",
      "reports.view",
      "portal.website_entry_points.read",
      "templates.manage",
    ]) {
      expect(isSensitivePermission(p), p).toBe(false);
    }
  });
  it("classifies the system role presets", () => {
    const by = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!;
    expect(isSensitiveRole(by("Admin").permissions)).toBe(true);
    expect(isSensitiveRole(by("Finance").permissions)).toBe(true);
    expect(isSensitiveRole(by("Care coordinator").permissions)).toBe(true);
    expect(isSensitiveRole(by("Marketing").permissions)).toBe(false);
    expect(isSensitiveRole([])).toBe(false);
  });
});

describe("mfaGate", () => {
  const base = {
    pathname: "/inbox",
    required: false,
    currentLevel: "aal1" as const,
    hasVerifiedFactor: false,
  };

  it("lets everyone through when MFA is neither required nor enrolled", () => {
    expect(mfaGate(base)).toBe("allow");
  });
  it("sends a required role without a factor to enrol", () => {
    expect(mfaGate({ ...base, required: true })).toBe("enroll");
  });
  it("challenges an enrolled user at aal1 even when their role does not require MFA", () => {
    expect(mfaGate({ ...base, hasVerifiedFactor: true })).toBe("verify");
    expect(mfaGate({ ...base, required: true, hasVerifiedFactor: true })).toBe("verify");
  });
  it("lets an aal2 session through", () => {
    expect(
      mfaGate({ ...base, required: true, hasVerifiedFactor: true, currentLevel: "aal2" }),
    ).toBe("allow");
  });
  it("treats a missing assurance level as unverified", () => {
    expect(mfaGate({ ...base, required: true, currentLevel: null })).toBe("enroll");
    expect(mfaGate({ ...base, hasVerifiedFactor: true, currentLevel: undefined })).toBe("verify");
  });
  it("never traps the user: the MFA pages, sign-out and sign-in stay reachable", () => {
    for (const pathname of [
      "/mfa/enroll",
      "/mfa/verify",
      "/auth/signout",
      "/login",
      "/auth/callback",
    ]) {
      expect(isMfaExemptPath(pathname), pathname).toBe(true);
      expect(
        mfaGate({ ...base, pathname, required: true, hasVerifiedFactor: true }),
        pathname,
      ).toBe("allow");
    }
    expect(isMfaExemptPath("/mfa-fake")).toBe(false);
    expect(isMfaExemptPath("/settings/account")).toBe(false);
  });
});
