import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MemberLike } from "@/lib/auth/can";
import { FINANCE_ROLES, PERMISSION_KEYS } from "@/lib/auth/permissions";
import { NAV_ITEMS } from "@/components/shell/nav";
import { badgesNeeded, FINANCE_NAV, financeLanding, financeNavFor } from "@/lib/finance/nav";

const member = (permissions: string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const role = (name: string) => FINANCE_ROLES.find((r) => r.name === name)!.permissions;
const hrefs = (m: MemberLike) => financeNavFor(m).map((e) => e.href);

describe("Finance navigation", () => {
  it("every entry points at a page that exists and uses only real permission keys", () => {
    for (const e of FINANCE_NAV) {
      const dir = join(process.cwd(), "app/(app)", e.href);
      expect(existsSync(join(dir, "page.tsx")), e.href).toBe(true);
      for (const p of e.permissions) expect(PERMISSION_KEYS, `${e.href} ${p}`).toContain(p);
    }
    expect(new Set(FINANCE_NAV.map((e) => e.href)).size).toBe(FINANCE_NAV.length);
  });

  it("the shell's Finance item is visible to anyone who can open any Finance entry", () => {
    const shell = NAV_ITEMS.find((i) => i.href === "/finance")!;
    const all = new Set(FINANCE_NAV.flatMap((e) => e.permissions));
    for (const p of all) expect(shell.permissions, p).toContain(p);
  });

  it("shows nothing to a member with no finance permission", () => {
    expect(financeNavFor(member(["contacts.view"]))).toEqual([]);
    expect(financeLanding(member([]))).toBeNull();
  });

  it("shows exactly the entries a member's permissions allow", () => {
    expect(hrefs(member(["finance.denials.manage"]))).toEqual(["/finance/denials"]);
    expect(hrefs(member(["finance.close.signoff.ceo"]))).toEqual(["/finance/close"]);
    expect(hrefs(member(["finance.recovery.approve"]))).toEqual(["/finance/recovery"]);
    expect(financeLanding(member(["finance.cashup.manage"]))).toBe("/finance/cashup");
  });

  it("the CEO preset sees reports and the close but cannot manage, send reminders or export", () => {
    const h = hrefs(member(role("CEO")));
    expect(h).toContain("/finance/close");
    expect(h).toContain("/finance/forecast");
    expect(h).not.toContain("/finance/recovery");
    expect(h).not.toContain("/finance/export");
    expect(h).not.toContain("/finance/cashup");
  });

  it("the Billing preset sees eligibility and cash-up but not denials or the close", () => {
    const h = hrefs(member(role("Billing")));
    expect(h).toContain("/finance/eligibility");
    expect(h).toContain("/finance/cashup");
    expect(h).not.toContain("/finance/denials");
    expect(h).not.toContain("/finance/close");
  });

  it("the flash report is read by Finance, the CEO and the Medical Director; only Finance edits targets", () => {
    for (const r of ["Finance", "CEO", "Medical Director"]) {
      expect(hrefs(member(role(r))), r).toContain("/finance/flash");
    }
    expect(hrefs(member(role("Finance")))).toContain("/finance/flash/settings");
    expect(hrefs(member(role("CEO")))).not.toContain("/finance/flash/settings");
    for (const r of ["Billing", "Insurance", "Cost / Payroll"]) {
      expect(hrefs(member(role(r))), r).not.toContain("/finance/flash");
    }
  });

  it("the Medical Director sees revenue and scorecards only", () => {
    expect(hrefs(member(role("Medical Director"))).sort()).toEqual(
      [
        "/finance/branches",
        "/finance/doctors",
        "/finance/flash",
        "/finance/revenue",
        "/finance/scorecards",
        "/finance/summary",
      ].sort(),
    );
  });

  it("the insurance overview needs claim access, so Insurance sees it and Billing and the Medical Director do not", () => {
    expect(hrefs(member(role("Insurance")))).toContain("/finance/insurance");
    expect(hrefs(member(role("Finance")))).toContain("/finance/insurance");
    expect(hrefs(member(role("CEO")))).toContain("/finance/insurance");
    for (const name of ["Billing", "Medical Director", "Cost / Payroll"])
      expect(hrefs(member(role(name))), name).not.toContain("/finance/insurance");
  });

  it("cost and profit pages follow the blueprint's separation of duties", () => {
    // Cost / Payroll: costs only, no revenue, branch, doctor or profit pages
    expect(hrefs(member(role("Cost / Payroll")))).toEqual(["/finance/costs"]);
    // CEO sees profitability but not the cost inputs
    const ceo = hrefs(member(role("CEO")));
    expect(ceo).toContain("/finance/profitability");
    expect(ceo).not.toContain("/finance/costs");
    // Billing and the Medical Director never see cost or profit pages
    for (const name of ["Billing", "Medical Director", "Insurance"]) {
      const h = hrefs(member(role(name)));
      expect(h, name).not.toContain("/finance/costs");
      expect(h, name).not.toContain("/finance/profitability");
    }
    // Finance sees all of it
    const fin = hrefs(member(role("Finance")));
    expect(fin).toEqual(
      expect.arrayContaining([
        "/finance/costs",
        "/finance/profitability",
        "/finance/doctors",
        "/finance/branches",
      ]),
    );
  });

  it("the sign-offs are split: finance and CEO presets each hold only their own key", () => {
    expect(role("Finance")).toContain("finance.close.signoff.finance");
    expect(role("Finance")).not.toContain("finance.close.signoff.ceo");
    expect(role("CEO")).toContain("finance.close.signoff.ceo");
    expect(role("CEO")).not.toContain("finance.close.signoff.finance");
  });

  it("badge counts only appear for members who can see the entry, and are fetched only when needed", () => {
    expect(badgesNeeded(member(["finance.cashup.manage"]))).toEqual([]);
    expect(badgesNeeded(member(["finance.denials.manage"]))).toEqual(["denials"]);
    const entries = financeNavFor(member(["finance.denials.manage", "finance.preauth.manage"]), {
      denials: 4,
    });
    expect(entries.find((e) => e.href === "/finance/denials")?.badge).toBe(4);
    expect(entries.find((e) => e.href === "/finance/preauth")?.badge).toBe(0);
  });

  it("Admin (*) sees every entry", () => {
    expect(financeNavFor(member(["*"]))).toHaveLength(FINANCE_NAV.length);
  });
});
