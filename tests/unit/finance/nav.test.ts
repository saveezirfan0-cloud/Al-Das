import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MemberLike } from "@/lib/auth/can";
import { FINANCE_ROLES, PERMISSION_KEYS } from "@/lib/auth/permissions";
import { NAV_ITEMS } from "@/components/shell/nav";
import {
  badgesNeeded,
  FINANCE_NAV,
  FINANCE_SETUP_PAGES,
  financeLanding,
  financeNavFor,
  financePagesFor,
  financeTabGroupsFor,
} from "@/lib/finance/nav";

const member = (permissions: string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const role = (name: string) => FINANCE_ROLES.find((r) => r.name === name)!.permissions;
// every Finance page a member reaches from a menu: entries, tabs of a tab group, and the setup pages under Settings
const hrefs = (m: MemberLike) => financePagesFor(m);

describe("Finance navigation", () => {
  it("every entry points at a page that exists and uses only real permission keys", () => {
    const pages = [...FINANCE_NAV.flatMap((e) => (e.tabs ? e.tabs : [e])), ...FINANCE_SETUP_PAGES];
    for (const e of pages) {
      const dir = join(process.cwd(), "app/(app)", e.href);
      expect(existsSync(join(dir, "page.tsx")), e.href).toBe(true);
      for (const p of e.permissions) expect(PERMISSION_KEYS, `${e.href} ${p}`).toContain(p);
    }
    expect(new Set(FINANCE_NAV.map((e) => e.href)).size).toBe(FINANCE_NAV.length);
    expect(new Set(pages.map((e) => e.href)).size).toBe(pages.length);
  });

  it("the shell's Finance item is visible to anyone who can open any Finance entry", () => {
    const shell = NAV_ITEMS.find((i) => i.href === "/finance")!;
    const all = new Set(FINANCE_NAV.flatMap((e) => e.permissions));
    // a tab group's permissions are the union of its tabs'
    for (const e of FINANCE_NAV.filter((x) => x.tabs))
      expect([...e.permissions].sort(), e.label).toEqual(
        [...new Set(e.tabs!.flatMap((t) => t.permissions))].sort(),
      );
    for (const p of all) expect(shell.permissions, p).toContain(p);
  });

  it("shows nothing to a member with no finance permission", () => {
    expect(financeNavFor(member(["contacts.view"]))).toEqual([]);
    expect(financeLanding(member([]))).toBeNull();
  });

  it("shows exactly the entries a member's permissions allow", () => {
    expect(hrefs(member(["finance.denials.manage"]))).toEqual(["/finance/denials"]);
    // a tab group opens the first tab the member may open
    expect(financeNavFor(member(["finance.forecast.view"])).map((e) => e.href)).toEqual([
      "/finance/reports",
      "/finance/forecast",
    ]);
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

  it("the close timetable is open to step owners (finance.close.tasks) without the close packs", () => {
    for (const r of ["Finance", "Billing", "Insurance", "Cost / Payroll", "CEO"])
      expect(hrefs(member(role(r))), r).toContain("/finance/close/timetable");
    expect(hrefs(member(role("Medical Director")))).not.toContain("/finance/close/timetable");
    const owner = hrefs(member(["finance.close.tasks"]));
    expect(owner).toEqual(["/finance/close/timetable"]);
    expect(owner).not.toContain("/finance/close");
  });

  it("payables and vouchers follow the zero-paper separation of duties", () => {
    const money = [
      "/finance/vouchers",
      "/finance/vouchers/report",
      "/finance/payables",
      "/finance/suppliers",
      "/finance/tally",
    ];
    // Finance (the makers) and the Finance Manager (the checker) see all of it, including the settings page
    for (const r of ["Finance", "Finance Manager"]) {
      expect(hrefs(member(role(r))), r).toEqual(
        expect.arrayContaining([...money, "/finance/vouchers/settings"]),
      );
    }
    // the CEO approves and reads, but neither exports to Tally nor edits the settings
    const ceo = hrefs(member(role("CEO")));
    expect(ceo).toEqual(
      expect.arrayContaining([
        "/finance/vouchers",
        "/finance/vouchers/report",
        "/finance/payables",
      ]),
    );
    expect(ceo).not.toContain("/finance/tally");
    expect(ceo).not.toContain("/finance/vouchers/settings");
    // a department head sees the vouchers (to approve Tier 2) and nothing else in Finance
    expect(hrefs(member(role("Department head"))).sort()).toEqual(
      ["/finance/vouchers", "/finance/vouchers/report"].sort(),
    );
    expect(financeLanding(member(role("Department head")))).toBe("/finance/vouchers");
    for (const r of ["Billing", "Insurance", "Medical Director", "Cost / Payroll"]) {
      const h = hrefs(member(role(r)));
      for (const page of [...money, "/finance/vouchers/settings"])
        expect(h, `${r} ${page}`).not.toContain(page);
    }
    // only the Finance Manager edits the delegation of authority (Finance reaches the page for the Tally ledgers)
    expect(role("Finance Manager")).toContain("finance.vouchers.settings");
    expect(role("Finance")).not.toContain("finance.vouchers.settings");
    expect(role("Finance")).not.toContain("finance.vouchers.check");
  });

  it("bank reconciliation is run by Finance and read by the CEO; nobody else sees it", () => {
    expect(hrefs(member(role("Finance")))).toEqual(
      expect.arrayContaining(["/finance/bank", "/finance/bank/settings"]),
    );
    expect(hrefs(member(role("CEO")))).toContain("/finance/bank");
    expect(hrefs(member(role("CEO")))).not.toContain("/finance/bank/settings");
    expect(role("Finance")).toEqual(
      expect.arrayContaining(["finance.bank.view", "finance.bank.manage", "finance.bank.signoff"]),
    );
    expect(role("CEO")).not.toContain("finance.bank.signoff");
    for (const r of ["Billing", "Insurance", "Medical Director", "Cost / Payroll"])
      expect(
        hrefs(member(role(r))).filter((h) => h.startsWith("/finance/bank")),
        r,
      ).toEqual([]);
  });

  it("the Finance inbox is for Finance and the Finance Manager only, next to Supplier invoices, with a badge", () => {
    for (const r of ["Finance", "Finance Manager"])
      expect(hrefs(member(role(r))), r).toContain("/finance/inbox");
    for (const r of [
      "CEO",
      "Department head",
      "Billing",
      "Insurance",
      "Medical Director",
      "Cost / Payroll",
    ])
      expect(hrefs(member(role(r))), r).not.toContain("/finance/inbox");
    // its own key: neither payables nor voucher rights imply it, and it implies nothing else
    expect(hrefs(member(["finance.payables.manage"]))).not.toContain("/finance/inbox");
    expect(hrefs(member(["finance.inbox.manage"]))).toEqual(["/finance/inbox"]);
    const money = FINANCE_NAV.filter((e) => e.section === "Money").map((e) => e.href);
    expect(money.indexOf("/finance/inbox") + 1).toBe(money.indexOf("/finance/payables"));
    expect(FINANCE_NAV.find((e) => e.href === "/finance/payables")?.label).toBe("Payables");
    expect(badgesNeeded(member(["finance.inbox.manage"]))).toEqual(["inbox"]);
    expect(badgesNeeded(member(["finance.payables.manage"]))).not.toContain("inbox");
  });

  it("lab and referral reconciliation: Finance and the Finance Manager run it, the CEO reads it, nobody else sees it", () => {
    for (const r of ["Finance", "Finance Manager"]) {
      expect(hrefs(member(role(r))), r).toEqual(
        expect.arrayContaining(["/finance/labs", "/finance/labs/settings"]),
      );
      expect(role(r), r).toEqual(
        expect.arrayContaining(["finance.labs.view", "finance.labs.manage"]),
      );
    }
    expect(hrefs(member(role("CEO")))).toContain("/finance/labs");
    expect(hrefs(member(role("CEO")))).not.toContain("/finance/labs/settings");
    expect(role("CEO")).not.toContain("finance.labs.manage");
    for (const r of ["Billing", "Insurance", "Medical Director", "Cost / Payroll", "Operations"]) {
      expect(
        hrefs(member(role(r))).filter((h) => h.startsWith("/finance/labs")),
        r,
      ).toEqual([]);
      expect(
        role(r).filter((p) => p.startsWith("finance.labs.")),
        r,
      ).toEqual([]);
    }
  });

  it("the Medical Director sees revenue and scorecards only", () => {
    expect(hrefs(member(role("Medical Director"))).sort()).toEqual(
      [
        "/finance/analytics",
        "/finance/branches",
        "/finance/doctor-performance", // Phase 23B: follows finance.revenue.view (docs/39 §4)
        "/finance/doctors",
        "/finance/flash",
        // Phase G: the reports hub, which shows them only the cards of the keys above (no costs or profit)
        "/finance/reports",
        "/finance/revenue",
        "/finance/scorecards",
        "/finance/summary",
      ].sort(),
    );
  });

  it("billing mix and trends follow revenue access: Finance, the CEO and the Medical Director, not Billing, Insurance or Cost / Payroll", () => {
    for (const r of ["Finance", "CEO", "Medical Director"])
      expect(hrefs(member(role(r))), r).toContain("/finance/analytics");
    for (const r of ["Billing", "Insurance", "Cost / Payroll"])
      expect(hrefs(member(role(r))), r).not.toContain("/finance/analytics");
  });

  it("the insurance overview needs claim access, so Insurance sees it and Billing and the Medical Director do not", () => {
    expect(hrefs(member(role("Insurance")))).toContain("/finance/insurance");
    expect(hrefs(member(role("Finance")))).toContain("/finance/insurance");
    expect(hrefs(member(role("CEO")))).toContain("/finance/insurance");
    for (const name of ["Billing", "Medical Director", "Cost / Payroll"])
      expect(hrefs(member(role(name))), name).not.toContain("/finance/insurance");
  });

  it("insurance follow-up and receivables by age need claim access: Insurance, Finance and the CEO, not Billing or the Medical Director", () => {
    for (const r of ["Insurance", "Finance", "CEO"]) {
      expect(hrefs(member(role(r))), r).toContain("/finance/followup");
      expect(hrefs(member(role(r))), r).toContain("/finance/receivables");
    }
    for (const r of ["Billing", "Medical Director", "Cost / Payroll"]) {
      expect(hrefs(member(role(r))), r).not.toContain("/finance/followup");
      expect(hrefs(member(role(r))), r).not.toContain("/finance/receivables");
    }
    // recording follow-ups is its own key, held by Insurance and Finance, not the read-only CEO
    expect(role("Insurance")).toContain("finance.followup.manage");
    expect(role("Finance")).toContain("finance.followup.manage");
    expect(role("CEO")).not.toContain("finance.followup.manage");
  });

  it("Uploads is listed for both uploads the page takes: the claims file (Insurance) and the Unite report (Finance)", () => {
    // the page opens with finance.claims.import OR finance.revenue.import (Phase 23A); the menu must agree
    for (const r of ["Insurance", "Finance", "Finance Manager"])
      expect(hrefs(member(role(r))), r).toContain("/finance/upload");
    expect(hrefs(member(["finance.revenue.import"]))).toEqual(["/finance/upload"]);
    for (const r of ["Billing", "CEO", "Medical Director", "Cost / Payroll"])
      expect(hrefs(member(role(r))), r).not.toContain("/finance/upload");
    const tab = FINANCE_NAV.flatMap((e) => e.tabs ?? []).find((t) => t.href === "/finance/upload")!;
    expect(tab.label).toBe("Uploads"); // the page's heading
    expect([...tab.permissions].sort()).toEqual([
      "finance.claims.import",
      "finance.revenue.import",
    ]);
  });

  it("invoice changes: Finance, the CEO and Operations see the register; Operations and Finance review, the CEO does not", () => {
    for (const r of ["Finance", "CEO", "Operations"])
      expect(hrefs(member(role(r))), r).toContain("/finance/invoice-changes");
    for (const r of ["Billing", "Insurance", "Medical Director", "Cost / Payroll"])
      expect(hrefs(member(role(r))), r).not.toContain("/finance/invoice-changes");
    // Operations owns Unite invoice changes and sees nothing else in Finance
    expect(hrefs(member(role("Operations")))).toEqual(["/finance/invoice-changes"]);
    expect(role("Operations")).toContain("finance.changes.review");
    expect(role("Finance")).toContain("finance.changes.review");
    expect(role("CEO")).not.toContain("finance.changes.review");
  });

  it("doctor revenue share is compensation data: Finance and the CEO only, with verify and approve split", () => {
    for (const r of ["Finance", "CEO"])
      expect(hrefs(member(role(r))), r).toContain("/finance/revenue-share");
    for (const r of ["Medical Director", "Billing", "Insurance", "Cost / Payroll"]) {
      expect(hrefs(member(role(r))), r).not.toContain("/finance/revenue-share");
      expect(
        role(r).filter((p) => p.startsWith("finance.revshare.")),
        r,
      ).toEqual([]);
    }
    // maker (Finance) and checker (Finance Manager) are different roles; the CEO approves
    expect(role("Finance")).toEqual(
      expect.arrayContaining(["finance.revshare.view", "finance.revshare.manage"]),
    );
    expect(role("Finance")).not.toContain("finance.revshare.verify");
    expect(role("Finance Manager")).toContain("finance.revshare.verify");
    expect(role("Finance")).not.toContain("finance.revshare.approve");
    expect(role("CEO")).toEqual(
      expect.arrayContaining(["finance.revshare.view", "finance.revshare.approve"]),
    );
    expect(role("CEO")).not.toContain("finance.revshare.verify");
    expect(role("CEO")).not.toContain("finance.revshare.manage");
    expect(hrefs(member(["finance.revshare.approve"]))).toEqual(["/finance/revenue-share"]);
  });

  it("cost and profit pages follow the blueprint's separation of duties", () => {
    // Cost / Payroll: costs (and its own close steps), no revenue, branch, doctor or profit pages
    expect(hrefs(member(role("Cost / Payroll"))).sort()).toEqual([
      "/finance/close/timetable",
      "/finance/costs",
    ]);
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

  it("Phase D: about twenty entries, siblings as tabs, setup under Settings", () => {
    expect(FINANCE_NAV.length).toBeLessThanOrEqual(22);
    expect([...new Set(FINANCE_NAV.map((e) => e.section))]).toEqual([
      "Reports",
      "Claims & collections",
      "Money",
      "Month-end",
    ]);
    // nothing was dropped: the menu, the tabs and the setup pages still reach every page the old menu listed (45), plus
    // Phase 23's Doctor performance and Phase G's Report e-mails (a setup page)
    expect(financePagesFor(member(["*"]))).toHaveLength(47);
    expect(FINANCE_SETUP_PAGES.map((p) => p.href)).toContain("/finance/report-emails");
    // the tab strip lists only the tabs a member may open, and only when there are two or more
    const md = financeTabGroupsFor(member(role("Medical Director")));
    expect(md.map((g) => g.label)).toEqual(["Performance"]);
    expect(md[0].tabs.map((t) => t.href)).not.toContain("/finance/profitability");
    expect(financeTabGroupsFor(member(["finance.forecast.view"]))).toEqual([]);
    // a tab group's badge belongs to its first tab
    expect(badgesNeeded(member(["finance.close.tasks"]))).toEqual([]);
    expect(badgesNeeded(member(["finance.close.view"]))).toEqual(["close"]);
  });
});
