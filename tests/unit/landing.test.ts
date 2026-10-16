import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { firstRunFor, firstRunStorageKey } from "@/lib/help/first-steps";
import { landingPathFor } from "@/lib/shell/landing";

const preset = (roleName: string) => ({
  status: "active" as const,
  roleName,
  permissions: SYSTEM_ROLES.find((r) => r.name === roleName)!.permissions,
});

describe("landingPathFor (Phase D role homes)", () => {
  it("sends each preset to its home", () => {
    const expected: Record<string, string> = {
      Receptionist: "/front-desk",
      Doctor: "/my-day",
      Agent: "/inbox",
      HR: "/staff",
      Manager: "/dashboard/management",
      CEO: "/dashboard/management",
      // Phase G: the Reports hub is the finance landing for holders of a report key
      Finance: "/finance/reports",
      "Finance Manager": "/finance/reports",
      // finance controls of 16 Oct 2026: revenue reports for Revenue & Collections, the finance inbox for Costs & Expenses
      "Revenue & Collections": "/finance/reports",
      "Costs & Expenses": "/finance/inbox",
      "Medical Director": "/finance/reports",
      Insurance: "/finance/reports",
      Billing: "/finance/invoices",
      "Cost / Payroll": "/finance/costs",
      "Department head": "/finance/vouchers",
      Operations: "/finance/invoice-changes",
      Accountant: "/accounting/dashboard",
      "Chief Accountant": "/accounting/dashboard",
      Auditor: "/accounting/dashboard",
      Admin: "/dashboard",
      Marketing: "/dashboard",
      "Care coordinator": "/dashboard",
    };
    for (const role of SYSTEM_ROLES)
      expect(landingPathFor(preset(role.name)), role.name).toBe(expected[role.name]);
  });

  it("matches the role name whatever its case or spacing", () => {
    expect(landingPathFor({ ...preset("Receptionist"), roleName: "  receptionist " })).toBe(
      "/front-desk",
    );
  });

  it("falls back to the dashboard when the role lacks its page's permission", () => {
    const base = { status: "active" as const, permissions: [] as string[] };
    expect(
      landingPathFor({ ...base, roleName: "Receptionist", permissions: ["appointments.view"] }),
    ).toBe("/dashboard");
    expect(landingPathFor({ ...base, roleName: "Doctor" })).toBe("/dashboard");
    expect(landingPathFor({ ...base, roleName: "Agent", permissions: ["contacts.view"] })).toBe(
      "/dashboard",
    );
    expect(landingPathFor({ ...base, roleName: "CEO", permissions: ["finance.view"] })).toBe(
      "/finance/reports",
    );
    expect(landingPathFor({ ...base, roleName: "Finance" })).toBe("/dashboard");
    expect(landingPathFor({ ...base, roleName: "Custom role", permissions: ["*"] })).toBe(
      "/dashboard",
    );
  });

  it("never lands a suspended member or a closed finance window on a page they cannot open", () => {
    expect(landingPathFor({ ...preset("Receptionist"), status: "suspended" })).toBe("/dashboard");
    expect(
      landingPathFor({ ...preset("Finance"), restrictedAreas: ["finance", "accounting"] }),
    ).toBe("/dashboard");
  });

  it("is what the root page uses", () => {
    const src = readFileSync(join(process.cwd(), "app/page.tsx"), "utf8");
    expect(src).toContain('from "@/lib/shell/landing"');
  });
});

describe("first-run checklist", () => {
  const full = (name: string) => ({ ...preset(name), userId: "u", orgId: "o", roleId: "r" });

  it("gives every preset three to five steps it can open", () => {
    for (const role of SYSTEM_ROLES) {
      const fr = firstRunFor(full(role.name));
      expect(fr.steps.length, role.name).toBeGreaterThanOrEqual(3);
      expect(fr.steps.length, role.name).toBeLessThanOrEqual(5);
      expect(new Set(fr.steps.map((s) => s.id)).size, role.name).toBe(fr.steps.length);
    }
  });

  it("drops steps the member cannot open and keys the dismissal by role", () => {
    const doctor = firstRunFor({
      userId: "u",
      orgId: "o",
      roleId: "r",
      status: "active",
      roleName: "Doctor",
      permissions: ["appointments.view"],
    });
    expect(doctor.steps.map((s) => s.href)).toContain("/my-day");
    expect(doctor.steps.map((s) => s.href)).not.toContain("/tasks");
    expect(firstRunStorageKey(doctor.key)).toBe("pulse-first-run-dismissed:doctor");
    const billing = firstRunFor(full("Billing"));
    expect(billing.key).toBe("finance");
    expect(billing.steps.map((s) => s.href)).toContain("/finance/exceptions");
  });

  it("wraps every storage access in try/catch", () => {
    const src = readFileSync(
      join(process.cwd(), "components/shell/first-run-checklist.tsx"),
      "utf8",
    );
    const uses = src.match(/localStorage\./g) ?? [];
    const guarded = src.match(/try \{\s*(return )?localStorage\./g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(uses.length);
  });
});
