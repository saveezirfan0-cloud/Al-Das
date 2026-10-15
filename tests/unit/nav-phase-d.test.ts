import { describe, expect, it } from "vitest";

import { buildAreas, GROUP_AREAS } from "@/components/shell/app-nav";
import { NAV_GROUPS, NAV_ITEMS } from "@/components/shell/nav";
import type { SidebarNode } from "@/components/shell/sidebar";
import type { MemberLike } from "@/lib/auth/can";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { NAV_MODULES } from "@/lib/nav/modules";
import { activeTabGroup } from "@/lib/nav/tabs";
import { activeTrail, buildNavTree, currentItem } from "@/lib/nav/tree";

// Phase D (docs/34 §3): the menu's areas, the CRM sub-headings, tab groups and what each role can reach.

const member = (permissions: readonly string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const role = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;
const treeFor = (perms: readonly string[]) =>
  buildNavTree(NAV_ITEMS, NAV_MODULES, member(perms)) as SidebarNode[];
const areaTitles = (perms: readonly string[]) => {
  const { top, bottom } = buildAreas(treeFor(perms));
  return [...top, ...bottom].map((a) => a.title);
};
const pagesOf = (perms: readonly string[]) =>
  treeFor(perms).flatMap((n) => [
    n.href,
    ...(n.sections ?? []).flatMap((s) => s.pages.map((p) => p.href)),
  ]);

describe("areas (docs/34 §3)", () => {
  it("has one rail entry per group, in the plan's order, with modules at their group's place", () => {
    expect(NAV_GROUPS).toEqual(["Today", "Messaging", "CRM", "Back office", "Insights"]);
    for (const g of NAV_GROUPS) expect(GROUP_AREAS[g], g).toBeDefined();
    expect(areaTitles(["*"])).toEqual([
      "Home",
      "Today",
      "Messaging",
      "CRM",
      "Finance",
      "Accounting",
      "Insights",
      "Settings",
    ]);
  });

  it("puts each page in its target area", () => {
    const groupOf = (href: string) => NAV_ITEMS.find((i) => i.href === href)?.group;
    for (const h of ["/front-desk", "/my-day", "/appointments", "/tasks", "/portal/follow-ups"])
      expect(groupOf(h), h).toBe("Today");
    for (const h of ["/inbox", "/templates", "/campaigns", "/flows", "/recall", "/media"])
      expect(groupOf(h), h).toBe("Messaging");
    for (const h of ["/contacts", "/enquiries", "/doctors", "/staff", "/settings/teams"])
      expect(groupOf(h), h).toBe("CRM");
    for (const h of ["/reports", "/dashboard/management", "/portal"])
      expect(groupOf(h), h).toBe("Insights");
  });

  it("lists CRM under People and Organisation, each sub-heading's items together", () => {
    const crm = NAV_ITEMS.filter((i) => i.group === "CRM");
    expect(crm.map((i) => i.subgroup)).toEqual([
      "People",
      "People",
      "Organisation",
      "Organisation",
      "Organisation",
      "Organisation",
      "Organisation",
    ]);
    expect(crm.map((i) => i.label)).toEqual([
      "Patients",
      "Enquiries",
      "Doctors",
      "Staff",
      "Rota",
      "Teams",
      "Branches",
    ]);
  });

  it("does not list Teams twice (CRM only, not Settings)", () => {
    const settings = NAV_MODULES["/settings"].map((e) => e.href);
    expect(settings).not.toContain("/settings/teams");
  });
});

describe("per-role menus", () => {
  it("hides the Inbox from roles without inbox rights", () => {
    for (const r of ["Doctor", "HR", "Finance", "Accountant", "CEO"])
      expect(pagesOf(role(r)), r).not.toContain("/inbox");
    for (const r of ["Agent", "Receptionist", "Manager", "Marketing", "Care coordinator"])
      expect(pagesOf(role(r)), r).toContain("/inbox");
  });

  it("gives every role a Home and Settings, and only areas it can use", () => {
    for (const r of SYSTEM_ROLES) {
      const titles = areaTitles(r.permissions);
      expect(titles[0], r.name).toBe("Home");
      expect(titles.at(-1), r.name).toBe("Settings");
    }
    expect(areaTitles(role("Receptionist"))).toEqual([
      "Home",
      "Today",
      "Messaging",
      "CRM",
      "Insights",
      "Settings",
    ]);
    expect(areaTitles(role("Finance"))).toEqual(["Home", "Finance", "Insights", "Settings"]);
    expect(areaTitles(role("HR"))).toEqual(["Home", "CRM", "Settings"]);
  });

  it("reaches the clinical follow-ups from Today for the Doctor and the Care coordinator", () => {
    for (const r of ["Doctor", "Care coordinator"]) {
      const today = treeFor(role(r))
        .filter((n) => n.group === "Today")
        .map((n) => n.href);
      expect(today, r).toContain("/portal/follow-ups");
    }
    expect(pagesOf(role("HR"))).not.toContain("/portal/follow-ups");
  });

  it("lists finance setup under Settings for Finance, and nothing of it for the CEO", () => {
    const settings = (perms: readonly string[], title = "Finance setup") =>
      treeFor(perms)
        .find((n) => n.href === "/settings")!
        .sections!.filter((s) => s.title === title)
        .flatMap((s) => s.pages.map((p) => p.href));
    expect(settings(role("Finance"))).toEqual(
      expect.arrayContaining(["/finance/reference", "/finance/bank/settings"]),
    );
    expect(settings(role("CEO"))).toEqual([]);
    expect(settings(role("Chief Accountant"), "Accounting setup")).toEqual(
      expect.arrayContaining(["/accounting/entities", "/accounting/tally-import"]),
    );
  });
});

describe("active trail and tabs", () => {
  const admin = treeFor(["*"]);

  it("marks a setup page under Settings even though its URL is under Finance", () => {
    const t = activeTrail(admin, "/finance/vouchers/settings");
    expect(t.item).toBe("/settings");
    expect(t.page).toBe("/finance/vouchers/settings");
    expect(activeTrail(admin, "/finance/vouchers/abc").page).toBe("/finance/payables");
  });

  it("keeps a tab group's entry highlighted on every tab", () => {
    const t = activeTrail(admin, "/finance/forecast");
    expect(t.module).toBe("/finance");
    expect(t.page).toBe("/finance/insurance");
    expect(activeTrail(admin, "/finance/flash").page).toBe("/finance/summary");
  });

  it("prefers the specific Today and Insights entries over Portal and Dashboard", () => {
    expect(activeTrail(admin, "/portal/follow-ups").item).toBe("/portal/follow-ups");
    expect(activeTrail(admin, "/portal/sync-review").item).toBe("/portal");
    expect(activeTrail(admin, "/dashboard/management").item).toBe("/dashboard/management");
    expect(activeTrail(admin, "/dashboard").item).toBe("/dashboard");
  });

  it("highlights CRM, Branches on the Locations tab of Clinic and appointments, and Settings on its other tabs", () => {
    const branches = "/settings/appointments?tab=locations";
    for (const search of ["?tab=locations", "tab=locations", new URLSearchParams("tab=locations")])
      expect(activeTrail(admin, "/settings/appointments", search)).toEqual({ item: branches });
    // the same page on another tab, or with no tab, is the Settings entry
    for (const search of ["?tab=services", "", undefined]) {
      const t = activeTrail(admin, "/settings/appointments", search);
      expect(t.item).toBe("/settings");
      expect(t.page).toBe("/settings/appointments");
    }
    // extra parameters do not matter; the same parameter on another path does not match
    expect(activeTrail(admin, "/settings/appointments", "?tab=locations&x=1").item).toBe(branches);
    expect(activeTrail(admin, "/settings/teams", "?tab=locations").item).toBe("/settings/teams");
    // and the area that owns the entry is CRM
    const { top } = buildAreas(admin);
    expect(top.find((a) => a.items.some((i) => i.href === branches))?.key).toBe("CRM");
  });

  it("titles the top bar with the most specific item, not the first prefix", () => {
    const title = (path: string) => currentItem(admin, path)?.label;
    expect(title("/dashboard/management")).toBe("Management");
    expect(title("/dashboard/team")).toBe("Dashboard");
    expect(title("/staff/rota")).toBe("Rota");
    expect(title("/staff")).toBe("Staff");
    expect(title("/portal/follow-ups")).toBe("Clinical follow-ups");
    expect(title("/portal/sync-review")).toBe("Portal");
    expect(title("/settings/teams")).toBe("Teams");
    expect(title("/finance/claims/abc")).toBe("Finance");
    expect(title("/nowhere")).toBeUndefined();
  });

  it("opens a tab group on the member's first tab and lists the tabs as plain data", () => {
    const md = treeFor(["finance.forecast.view", "finance.scorecards.view"]);
    const finance = md.find((n) => n.href === "/finance")!;
    const page = finance
      .sections!.flatMap((s) => s.pages)
      .find((p) => p.label === "Insurance and receivables")!;
    expect(page.href).toBe("/finance/scorecards");
    expect(page.tabs?.map((t) => t.href)).toEqual(["/finance/scorecards", "/finance/forecast"]);
  });

  it("the tab strip picks the most specific tab and skips excluded pages", () => {
    const groups = [
      {
        label: "Payables",
        tabs: [
          { href: "/x/vouchers", label: "Vouchers" },
          { href: "/x/vouchers/report", label: "Report" },
        ],
      },
      { label: "Solo", tabs: [{ href: "/x/solo", label: "Solo" }] },
    ];
    expect(activeTabGroup(groups, "/x/vouchers/report")?.active).toBe("/x/vouchers/report");
    expect(activeTabGroup(groups, "/x/vouchers/123")?.active).toBe("/x/vouchers");
    expect(activeTabGroup(groups, "/x/vouchers/settings", ["/x/vouchers/settings"])).toBeNull();
    expect(activeTabGroup(groups, "/x/solo")).toBeNull();
    expect(activeTabGroup(groups, "/elsewhere")).toBeNull();
  });
});

describe("a tab that needs two keys (allow)", () => {
  it("lists the recruitment calculator only to members holding profit AND compensation, in the tree as in Finance", () => {
    const has = (perms: readonly string[]) =>
      treeFor(perms)
        .flatMap((n) => (n.sections ?? []).flatMap((s) => s.pages))
        .some((p) =>
          [p.href, ...(p.tabs ?? []).map((t) => t.href)].includes("/finance/recruitment"),
        );
    expect(has(["finance.profit.view", "finance.costs.compensation"])).toBe(true);
    expect(has(["finance.profit.view"])).toBe(false);
    expect(has(["finance.costs.compensation"])).toBe(false);
    expect(has(role("Cost / Payroll"))).toBe(false);
  });
});
