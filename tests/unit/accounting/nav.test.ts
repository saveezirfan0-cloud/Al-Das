import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components/shell/nav";
import {
  ACCOUNTING_KEYS,
  ACCOUNTING_NAV,
  accountingLanding,
  accountingNavFor,
} from "@/lib/accounting/nav";
import type { MemberLike } from "@/lib/auth/can";
import {
  ACCOUNTING_ROLES,
  FINANCE_ROLES,
  PERMISSION_KEYS,
  PERMISSIONS,
  SYSTEM_ROLES,
} from "@/lib/auth/permissions";
import { guideForPath } from "@/lib/help/guides";

const member = (permissions: readonly string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const role = (name: string) =>
  [...FINANCE_ROLES, ...ACCOUNTING_ROLES].find((r) => r.name === name)!.permissions;
const hrefs = (perms: readonly string[]) => accountingNavFor(member(perms)).map((e) => e.href);

describe("Accounting navigation", () => {
  it("every entry points at a page that exists, uses real keys, and has a guide", () => {
    for (const e of ACCOUNTING_NAV) {
      expect(existsSync(join(process.cwd(), "app/(app)", e.href, "page.tsx")), e.href).toBe(true);
      for (const p of e.permissions) expect(PERMISSION_KEYS, `${e.href} ${p}`).toContain(p);
      expect(guideForPath(e.href).id, e.href).toMatch(/^accounting/);
    }
    expect(new Set(ACCOUNTING_NAV.map((e) => e.href)).size).toBe(ACCOUNTING_NAV.length);
  });

  it("follows the plan's sections in order", () => {
    expect([...new Set(ACCOUNTING_NAV.map((e) => e.section))]).toEqual([
      "Overview",
      "Ledger",
      "Sales & receivables",
      "Purchases & payables",
      "Banking",
      "Assets",
      "Reports",
      "Close",
    ]);
  });

  it("the shell's Accounting item is visible to anyone holding any accounting key", () => {
    const shell = NAV_ITEMS.find((i) => i.href === "/accounting")!;
    expect(shell.icon).toBe("accounting");
    expect(shell.group).toBe("Back office");
    expect([...(shell.permissions ?? [])].sort()).toEqual([...ACCOUNTING_KEYS].sort());
    const catalogue = PERMISSIONS.filter((p) => p.key.startsWith("accounting.")).map((p) => p.key);
    expect([...ACCOUNTING_KEYS].sort()).toEqual(catalogue.sort());
    expect(catalogue).toHaveLength(15);
    for (const p of PERMISSIONS.filter((x) => x.key.startsWith("accounting.")))
      expect(p.group).toBe("Accounting");
    for (const e of ACCOUNTING_NAV)
      for (const p of e.permissions) expect(shell.permissions, p).toContain(p);
  });

  it("shows nothing without an accounting key", () => {
    expect(accountingNavFor(member(["finance.view"]))).toEqual([]);
    expect(accountingLanding(member([]))).toBeNull();
  });

  it("presets: the auditor reads, the accountant prepares, the chief accountant holds everything", () => {
    expect(role("Auditor").sort()).toEqual(
      ["accounting.ledger.view", "accounting.reports.view", "accounting.view"].sort(),
    );
    expect(role("Accountant")).toContain("accounting.journals.prepare");
    expect(role("Accountant")).not.toContain("accounting.journals.approve");
    expect(role("Accountant")).not.toContain("accounting.periods.manage");
    expect([...role("Chief Accountant")].sort()).toEqual([...ACCOUNTING_KEYS].sort());
    expect(hrefs(role("Auditor"))).toEqual(
      expect.arrayContaining([
        "/accounting/journals",
        "/accounting/trial-balance",
        "/accounting/day-book",
      ]),
    );
    expect(accountingLanding(member(role("Auditor")))).toBe("/accounting/dashboard");
  });

  it("the Finance Manager posts and reads; the CEO reads the reports but not journals", () => {
    expect(role("Finance Manager")).toEqual(
      expect.arrayContaining([
        "accounting.view",
        "accounting.ledger.view",
        "accounting.reports.view",
        "accounting.journals.approve",
      ]),
    );
    expect(role("Finance Manager")).not.toContain("accounting.journals.prepare");
    expect(
      role("CEO")
        .filter((p) => p.startsWith("accounting."))
        .sort(),
    ).toEqual(["accounting.reports.view", "accounting.view"]);
    const ceo = hrefs(role("CEO"));
    expect(ceo).toContain("/accounting/trial-balance");
    expect(ceo).not.toContain("/accounting/journals");
    expect(ceo).not.toContain("/accounting/ledger");
    // nobody else in finance gets accounting keys
    for (const r of [
      "Finance",
      "Billing",
      "Insurance",
      "Medical Director",
      "Cost / Payroll",
      "Department head",
      "Operations",
    ])
      expect(
        role(r).filter((p) => p.startsWith("accounting.")),
        r,
      ).toEqual([]);
    expect(SYSTEM_ROLES.map((r) => r.name)).toEqual(
      expect.arrayContaining(["Accountant", "Chief Accountant", "Auditor"]),
    );
  });

  it("Admin (*) sees every entry", () => {
    expect(accountingNavFor(member(["*"]))).toHaveLength(ACCOUNTING_NAV.length);
  });
});
