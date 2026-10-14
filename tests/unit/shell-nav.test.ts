import { describe, expect, it } from "vitest";

import { NAV_GROUPS, NAV_ITEMS } from "@/components/shell/nav";
import {
  SETTINGS_PAGES,
  SETTINGS_SECTIONS,
  visibleSettingsPages,
} from "@/components/shell/settings-pages";
import type { MemberLike } from "@/lib/auth/can";
import { pushRecent, rankQuickLinks, withRecentFirst } from "@/lib/shell/quick-links";

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

  it("shows admins everything and ordinary staff only their own pages (account and notifications)", () => {
    expect(visibleSettingsPages(member(["*"])).length).toBe(SETTINGS_PAGES.length);
    const staff = visibleSettingsPages(member(["inbox.send"]));
    expect(staff.map((p) => p.href)).toEqual(["/settings/account", "/settings/notifications"]);
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

describe("recent pages", () => {
  it("puts the newest first, drops repeats and caps the list", () => {
    expect(pushRecent([], "/inbox")).toEqual(["/inbox"]);
    expect(pushRecent(["/tasks", "/inbox", "/contacts"], "/inbox")).toEqual([
      "/inbox",
      "/tasks",
      "/contacts",
    ]);
    expect(pushRecent(["/a", "/b", "/c", "/d", "/e"], "/f")).toEqual([
      "/f",
      "/a",
      "/b",
      "/c",
      "/d",
    ]);
    expect(pushRecent(["/a", "/b"], "/c", 2)).toEqual(["/c", "/a"]);
  });

  it("lists recent links first in recent order and keeps the rest in their own order", () => {
    const links = [
      { href: "/inbox", label: "Inbox" },
      { href: "/tasks", label: "Tasks" },
      { href: "/contacts", label: "Contacts" },
    ];
    const { recent, rest } = withRecentFirst(links, ["/contacts", "/inbox"]);
    expect(recent.map((l) => l.href)).toEqual(["/contacts", "/inbox"]);
    expect(rest.map((l) => l.href)).toEqual(["/tasks"]);
  });

  it("hides remembered pages the member can no longer open", () => {
    const links = [{ href: "/inbox", label: "Inbox" }];
    const { recent, rest } = withRecentFirst(links, ["/settings/users", "/inbox"]);
    expect(recent.map((l) => l.href)).toEqual(["/inbox"]);
    expect(rest).toEqual([]);
    expect(withRecentFirst(links, []).recent).toEqual([]);
  });
});

describe("Phase 16 navigation", () => {
  it("shows the Media Library to anyone who can view or manage it, and to nobody else", () => {
    const item = NAV_ITEMS.find((i) => i.href === "/media")!;
    expect(item).toBeDefined();
    expect(item.group).toBe("Messaging");
    expect(item.permissions).toEqual(["media.view", "media.manage"]);
    const sees = (perms: string[]) => item.permissions!.some((p) => perms.includes(p));
    expect(sees(["media.view"])).toBe(true);
    expect(sees(["media.manage"])).toBe(true);
    expect(sees(["templates.manage", "contacts.view", "documents.view"])).toBe(false);
  });

  it("puts Patient documents settings behind settings.manage and makes them findable", () => {
    const page = SETTINGS_PAGES.find((p) => p.href === "/settings/documents")!;
    expect(page.section).toBe("Clinic operations");
    expect(page.allow(member(["documents.manage", "documents.view"]))).toBe(false);
    expect(page.allow(member(["settings.manage"]))).toBe(true);
    expect(page.keywords).toEqual(
      expect.arrayContaining(["insurance card", "retention", "storage"]),
    );
  });
});

describe("organisation navigation (CRM)", () => {
  const crm = NAV_ITEMS.filter((i) => i.group === "CRM").map((i) => i.href);
  const sees = (href: string, perms: string[]) => {
    const item = NAV_ITEMS.find((i) => i.href === href)!;
    if (item.permission) return perms.includes(item.permission);
    return item.permissions ? item.permissions.some((p) => perms.includes(p)) : true;
  };

  it("lists patients, enquiries, doctors, appointments, staff and the rota together, Appointments after Doctors", () => {
    expect(crm).toEqual([
      "/contacts",
      "/enquiries",
      "/doctors",
      "/appointments",
      "/staff",
      "/staff/rota",
    ]);
  });

  it("gates the Rota like its page: hr.view or appointments.view", () => {
    expect(sees("/staff/rota", ["hr.view"])).toBe(true);
    expect(sees("/staff/rota", ["appointments.view"])).toBe(true);
    expect(sees("/staff/rota", ["contacts.view", "tasks.view"])).toBe(false);
  });

  it("finds the doctor settings from the Appointment rules page keywords", () => {
    const page = SETTINGS_PAGES.find((p) => p.href === "/settings/appointments")!;
    expect(page.keywords).toEqual(
      expect.arrayContaining([
        "doctors",
        "specialists",
        "locations",
        "branches",
        "services",
        "working hours",
      ]),
    );
  });
});
