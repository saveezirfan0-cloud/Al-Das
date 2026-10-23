import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components/shell/nav";
import { NAV_MODULES } from "@/lib/nav/modules";
import {
  ALWAYS_SHOWN,
  cleanMenuHidden,
  combinedMenuHidden,
  hiddenEntryFor,
  linkIsHidden,
  MENU_CHOICES,
  menuChoicesFor,
  PAGE_HIDDEN_PATH,
  readOrgMenuHidden,
  withoutHiddenEntries,
  writeOrgMenuHidden,
} from "@/lib/nav/menu-visibility";
import { buildNavTree } from "@/lib/nav/tree";

const admin = {
  userId: "u",
  orgId: "o",
  roleId: "r",
  roleName: "Admin",
  status: "active" as const,
  permissions: ["*"],
};

describe("menu choices", () => {
  it("offers every top-level entry except Dashboard and Settings, once each", () => {
    const hrefs = MENU_CHOICES.map((c) => c.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const h of ALWAYS_SHOWN) expect(hrefs).not.toContain(h);
    expect(hrefs.length).toBe(NAV_ITEMS.length - ALWAYS_SHOWN.length);
  });

  it("keeps groups together", () => {
    const groups = MENU_CHOICES.map((c) => c.group);
    const runs = groups.filter((g, i) => i === 0 || groups[i - 1] !== g);
    expect(new Set(runs).size).toBe(runs.length);
  });

  it("offers a role only what it can see", () => {
    const agent = { ...admin, roleName: "Agent", permissions: ["inbox.send", "contacts.view"] };
    expect(menuChoicesFor(agent).map((c) => c.href)).toEqual(["/inbox", "/contacts"]);
    expect(menuChoicesFor({ ...admin, permissions: [] })).toEqual([]);
  });

  it("the hidden page is under no menu entry, so it can never be hidden itself", () => {
    const everything = MENU_CHOICES.map((c) => c.href);
    expect(hiddenEntryFor(PAGE_HIDDEN_PATH, everything)).toBeNull();
    expect(hiddenEntryFor("/dashboard", everything)).toBeNull();
    expect(hiddenEntryFor("/settings/account", everything)).toBeNull();
  });
});

describe("stored lists", () => {
  it("drops unknown, non-string and always-shown values and keeps menu order", () => {
    expect(cleanMenuHidden(["/finance", 3, "/nope", "/dashboard", "/inbox", "/inbox"])).toEqual([
      "/inbox",
      "/finance",
    ]);
    expect(cleanMenuHidden("not a list")).toEqual([]);
    expect(cleanMenuHidden(null)).toEqual([]);
  });

  it("reads and writes orgs.settings.menu without touching other keys", () => {
    const settings = { inbox: { a: 1 }, menu: { other: true, hidden: ["/campaigns"] } };
    expect(readOrgMenuHidden(settings)).toEqual(["/campaigns"]);
    expect(readOrgMenuHidden({})).toEqual([]);
    expect(readOrgMenuHidden(null)).toEqual([]);
    expect(readOrgMenuHidden({ menu: "x" })).toEqual([]);
    const next = writeOrgMenuHidden(settings, ["/recall", "/bogus"]);
    expect(next).toEqual({ inbox: { a: 1 }, menu: { other: true, hidden: ["/recall"] } });
    expect(settings.menu.hidden).toEqual(["/campaigns"]);
  });

  it("combines the workspace list with the person's own", () => {
    expect(combinedMenuHidden({ menu: { hidden: ["/finance"] } }, ["/inbox", "/finance"])).toEqual([
      "/inbox",
      "/finance",
    ]);
    expect(combinedMenuHidden(null, null)).toEqual([]);
  });
});

describe("hidden pages", () => {
  it("matches the most specific entry", () => {
    expect(hiddenEntryFor("/finance/vouchers/123", ["/finance"])).toBe("/finance");
    expect(hiddenEntryFor("/staff/rota", ["/staff"])).toBeNull();
    expect(hiddenEntryFor("/staff/abc", ["/staff"])).toBe("/staff");
    expect(hiddenEntryFor("/portal/follow-ups", ["/portal"])).toBeNull();
    expect(hiddenEntryFor("/portal/anything", ["/portal"])).toBe("/portal");
    expect(hiddenEntryFor("/dashboard/management", ["/dashboard/management"])).toBe(
      "/dashboard/management",
    );
    expect(hiddenEntryFor("/dashboard", ["/dashboard/management"])).toBeNull();
    expect(hiddenEntryFor("/settings/teams", ["/settings/teams"])).toBe("/settings/teams");
    expect(hiddenEntryFor(null, ["/finance"])).toBeNull();
    expect(hiddenEntryFor("/api/jobs/x", ["/finance"])).toBeNull();
  });

  it("matches a link with a query only with the same query", () => {
    const branches = "/settings/appointments?tab=locations";
    expect(linkIsHidden(branches, [branches])).toBe(true);
    expect(linkIsHidden("/settings/appointments", [branches])).toBe(false);
    expect(linkIsHidden("/inbox?folder=mine", ["/inbox"])).toBe(true);
  });
});

describe("withoutHiddenEntries", () => {
  it("drops hidden entries and module pages that live under them", () => {
    const tree = buildNavTree(NAV_ITEMS, NAV_MODULES, admin);
    const out = withoutHiddenEntries(tree, ["/finance", "/inbox"]);
    const hrefs = out.map((i) => i.href);
    expect(hrefs).not.toContain("/finance");
    expect(hrefs).not.toContain("/inbox");
    expect(hrefs).toContain("/settings");
    const settingsPages = out
      .find((i) => i.href === "/settings")!
      .sections!.flatMap((s) => s.pages.map((p) => p.href));
    expect(settingsPages.some((h) => h.startsWith("/finance/"))).toBe(false);
    expect(settingsPages).toContain("/settings/menu");
    // nothing hidden: the same tree
    expect(withoutHiddenEntries(tree, [])).toEqual(tree);
  });
});
