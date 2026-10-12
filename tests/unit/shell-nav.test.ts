import { describe, expect, it } from "vitest";

import { NAV_GROUPS, NAV_ITEMS } from "@/components/shell/nav";
import {
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  visibleSettingsPages,
} from "@/components/shell/settings-pages";
import type { MemberLike } from "@/lib/auth/can";
import { rankQuickLinks } from "@/lib/shell/quick-links";

const member = (permissions: string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});

describe("navigation", () => {
  it("puts every grouped item in a known group, with unique links", () => {
    for (const item of NAV_ITEMS) {
      if (item.group) expect(NAV_GROUPS).toContain(item.group);
    }
    const hrefs = NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("keeps Dashboard and Settings outside the groups", () => {
    expect(NAV_ITEMS.find((i) => i.href === "/dashboard")?.group).toBeUndefined();
    expect(NAV_ITEMS.find((i) => i.href === "/settings")?.group).toBeUndefined();
  });

  it("gives every Settings page a known section and a unique link", () => {
    for (const p of SETTINGS_PAGES) expect(SETTINGS_SECTIONS).toContain(p.section);
    expect(new Set(SETTINGS_PAGES.map((p) => p.href)).size).toBe(SETTINGS_PAGES.length);
  });

  it("shows admins everything and ordinary staff only their account", () => {
    expect(visibleSettingsPages(member(["*"])).length).toBe(SETTINGS_PAGES.length);
    const staff = visibleSettingsPages(member(["inbox.send"]));
    expect(staff.map((p) => p.href)).toEqual(["/settings/account"]);
  });

  it("offers Tags to contact managers and the knowledge base to kb managers", () => {
    const hrefs = visibleSettingsPages(member(["contacts.manage", "kb.manage"])).map((p) => p.href);
    expect(hrefs).toContain("/settings/tags");
    expect(hrefs).toContain("/settings/knowledge-base");
    expect(hrefs).not.toContain("/settings/users");
  });

  it("hides the Activity log from members without settings.manage", () => {
    const hrefs = visibleSettingsPages(member(["contacts.manage"])).map((p) => p.href);
    expect(hrefs).not.toContain("/settings/activity");
  });
});

describe("quick links", () => {
  const links = [
    {
      href: "/appointments",
      label: "Appointments",
      keywords: ["calendar", "diary"],
      hint: "Today",
    },
    { href: "/contacts", label: "Contacts", keywords: ["patients"], hint: "Patients" },
    {
      href: "/settings/activity",
      label: "Activity log",
      keywords: ["audit"],
      hint: "Settings · Security & audit",
    },
  ];

  it("returns everything for an empty query", () => {
    expect(rankQuickLinks("  ", links)).toHaveLength(3);
  });

  it("matches labels, keywords and the section hint", () => {
    expect(rankQuickLinks("appoint", links)[0].href).toBe("/appointments");
    expect(rankQuickLinks("calendar", links)[0].href).toBe("/appointments");
    expect(rankQuickLinks("audit", links)[0].href).toBe("/settings/activity");
    expect(rankQuickLinks("security", links)[0].href).toBe("/settings/activity");
  });

  it("requires every word to match and drops non-matches", () => {
    expect(rankQuickLinks("activity zzz", links)).toEqual([]);
    expect(rankQuickLinks("patients contacts", links)[0].href).toBe("/contacts");
  });

  it("prefers a label prefix over a keyword hit", () => {
    const mixed = [
      { href: "/a", label: "Reports", keywords: ["patients"] },
      { href: "/b", label: "Patient list" },
    ];
    expect(rankQuickLinks("patient", mixed)[0].href).toBe("/b");
  });
});
