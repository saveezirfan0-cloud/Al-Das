import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components/shell/nav";
import { SETTINGS_FOREIGN_PREFIXES, SETTINGS_PAGES } from "@/components/shell/settings-pages";
import type { MemberLike } from "@/lib/auth/can";
import { FINANCE_NAV } from "@/lib/finance/nav";
import { NAV_MODULES, type ModuleEntry } from "@/lib/nav/modules";
import {
  collapseAll,
  expandAll,
  groupKey,
  isOpen,
  moduleKey,
  NAV_STATE_COOKIE,
  navStateCookie,
  parseNavState,
  revealActive,
  sectionStateKey,
  serializeNavState,
  setOpen,
} from "@/lib/nav/state";
import { activeTrail, buildNavTree, hrefMatch, sectionKey, treeKeys } from "@/lib/nav/tree";

const member = (permissions: string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});

const ITEMS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/books", label: "Books", permissions: ["books.view", "books.post"] },
  { href: "/tasks", label: "Tasks", permission: "tasks.view" },
  { href: "/empty", label: "Empty" },
] as const;

const BOOKS: ModuleEntry[] = [
  { href: "/books/home", label: "Home", section: "Overview", permissions: ["books.view"] },
  { href: "/books/ledger", label: "Ledger", section: "Ledger", permissions: ["books.view"] },
  { href: "/books/post", label: "Post", section: "Ledger", permissions: ["books.post"] },
  { href: "/books/setup", label: "Setup", section: "Setup", permissions: ["books.admin"] },
  { href: "/books/ratios", label: "Ratios", section: "Overview", permissions: ["books.view"] },
];
const MODULES = {
  "/books": BOOKS,
  "/empty": [{ href: "/empty/x", label: "X", section: "S", permissions: ["nobody.has"] }],
};

describe("buildNavTree", () => {
  it("filters top-level items and module pages by permission, in order", () => {
    const tree = buildNavTree(ITEMS, MODULES, member(["books.view"]));
    expect(tree.map((n) => n.href)).toEqual(["/dashboard", "/books"]);
    const books = tree[1];
    expect(books.sections?.map((s) => s.title)).toEqual(["Overview", "Ledger"]);
    // sections keep first-seen order and pages keep list order, even when a section is split in the list
    expect(books.sections?.[0].pages.map((p) => p.href)).toEqual(["/books/home", "/books/ratios"]);
    expect(books.sections?.[1].pages.map((p) => p.href)).toEqual(["/books/ledger"]);
    expect(books.sections?.[0].key).toBe(sectionKey("/books", "Overview"));
  });

  it("drops empty sections and a module with no visible pages", () => {
    const tree = buildNavTree(ITEMS, MODULES, member(["books.post"]));
    const books = tree.find((n) => n.href === "/books")!;
    expect(books.sections?.map((s) => s.title)).toEqual(["Ledger"]);
    expect(books.sections?.[0].pages.map((p) => p.label)).toEqual(["Post"]);
    expect(tree.find((n) => n.href === "/empty")).toBeUndefined();
    expect(buildNavTree(ITEMS, MODULES, member([])).map((n) => n.href)).toEqual(["/dashboard"]);
  });

  it("gives suspended members nothing gated, and wildcard admins everything", () => {
    const suspended = { ...member(["*"]), status: "suspended" as const };
    expect(buildNavTree(ITEMS, MODULES, suspended).map((n) => n.href)).toEqual(["/dashboard"]);
    const admin = buildNavTree(ITEMS, MODULES, member(["*"]));
    expect(admin.find((n) => n.href === "/books")?.sections?.flatMap((s) => s.pages)).toHaveLength(
      5,
    );
  });

  it("honours an entry's own allow() (Settings pages) and outputs plain data only", () => {
    const tree = buildNavTree(NAV_ITEMS, NAV_MODULES, member(["inbox.send"]));
    const settings = tree.find((n) => n.href === "/settings")!;
    expect(settings.sections?.flatMap((s) => s.pages.map((p) => p.href))).toEqual([
      "/settings/account",
      "/settings/notifications",
    ]);
    expect(tree.find((n) => n.href === "/finance")).toBeUndefined();
    // the tree crosses into client components: no functions allowed
    expect(JSON.parse(JSON.stringify(tree))).toEqual(tree);
  });

  it("lists every Finance and Settings page for an admin, sections as written", () => {
    const tree = buildNavTree(NAV_ITEMS, NAV_MODULES, member(["*"]));
    const finance = tree.find((n) => n.href === "/finance")!;
    expect(finance.sections?.flatMap((s) => s.pages.map((p) => p.href))).toEqual(
      FINANCE_NAV.map((e) => e.href),
    );
    expect(finance.sections?.map((s) => s.title)).toEqual([
      ...new Set(FINANCE_NAV.map((e) => e.section)),
    ]);
    const settings = tree.find((n) => n.href === "/settings")!;
    expect(settings.sections?.flatMap((s) => s.pages)).toHaveLength(SETTINGS_PAGES.length);
  });
});

describe("module registry", () => {
  it("registers only real top-level items, with unique page links", () => {
    const tops = NAV_ITEMS.map((i) => i.href);
    for (const [href, entries] of Object.entries(NAV_MODULES)) {
      expect(tops, href).toContain(href);
      expect(new Set(entries.map((e) => e.href)).size).toBe(entries.length);
      // Settings also lists the finance and accounting setup pages at their own URLs (Phase D)
      const prefixes =
        href === "/settings" ? [href + "/", ...SETTINGS_FOREIGN_PREFIXES] : [href + "/"];
      for (const e of entries)
        expect(
          prefixes.some((p) => e.href.startsWith(p)),
          e.href,
        ).toBe(true);
    }
  });
});

describe("activeTrail", () => {
  const tree = buildNavTree(ITEMS, MODULES, member(["*"]));

  it("finds the module, section and longest matching page", () => {
    expect(activeTrail(tree, "/books/ledger")).toEqual({
      item: "/books",
      module: "/books",
      section: sectionKey("/books", "Ledger"),
      page: "/books/ledger",
    });
    expect(activeTrail(tree, "/books/ratios/2026-10").page).toBe("/books/ratios");
  });

  it("marks the module without a page on its landing, and a plain item outside modules", () => {
    expect(activeTrail(tree, "/books")).toEqual({ item: "/books", module: "/books" });
    expect(activeTrail(tree, "/tasks/123")).toEqual({ item: "/tasks" });
    expect(activeTrail(tree, "/bookshelf")).toEqual({});
  });

  it("matches an entry with a query only on its exact path with the same parameter values", () => {
    expect(hrefMatch("/a/b?tab=x", "/a/b", "?tab=x")).toBe("/a/b?tab=x".length);
    expect(hrefMatch("/a/b?tab=x", "/a/b", new URLSearchParams("tab=x&y=2"))).toBeGreaterThan(
      hrefMatch("/a/b", "/a/b", "?tab=x"),
    );
    expect(hrefMatch("/a/b?tab=x", "/a/b", "?tab=y")).toBe(-1);
    expect(hrefMatch("/a/b?tab=x", "/a/b", "")).toBe(-1);
    expect(hrefMatch("/a/b?tab=x", "/a/b", undefined)).toBe(-1);
    expect(hrefMatch("/a/b?tab=x", "/a/b/c", "?tab=x")).toBe(-1);
    expect(hrefMatch("/a/b?tab=x&v=1", "/a/b", "?v=1&tab=x")).toBe("/a/b?tab=x&v=1".length);
    expect(hrefMatch("/a/b?tab=x&v=1", "/a/b", "?tab=x")).toBe(-1);
    // a plain href still matches its path and below, whatever the query
    expect(hrefMatch("/a", "/a/b", "?tab=x")).toBe(2);
    expect(hrefMatch("/a", "/ab", "")).toBe(-1);
  });

  it("collects every module and section key", () => {
    const keys = treeKeys(tree);
    expect(keys.modules).toEqual(["/books", "/empty"]); // "*" holds every key
    expect(keys.sections).toEqual([
      ...["Overview", "Ledger", "Setup"].map((s) => sectionKey("/books", s)),
      sectionKey("/empty", "S"),
    ]);
  });
});

describe("nav state cookie", () => {
  it("round-trips modules, minimised sections and groups", () => {
    let s = setOpen({}, moduleKey("/finance"), true);
    s = setOpen(s, sectionStateKey(sectionKey("/finance", "Billing & claims")), false);
    s = setOpen(s, groupKey("Insights"), false);
    s = setOpen(s, moduleKey("/settings"), false);
    const raw = serializeNavState(s);
    expect(raw).not.toMatch(/[;,\s]/); // safe as a cookie value
    expect(parseNavState(raw)).toEqual(s);
    expect(navStateCookie(s)).toBe(
      `${NAV_STATE_COOKIE}=${raw}; path=/; max-age=31536000; samesite=lax`,
    );
  });

  it("stores only the minimised state of sections and groups; modules both ways", () => {
    const sec = sectionStateKey("/finance>Money");
    expect(setOpen({ [sec]: false }, sec, true)).toEqual({});
    expect(setOpen({}, moduleKey("/finance"), false)).toEqual({ "m/finance": false });
  });

  it("ignores garbage, oversized values and unknown keys", () => {
    expect(parseNavState(undefined)).toEqual({});
    expect(parseNavState("%E0%A4%A")).toEqual({});
    expect(parseNavState("x".repeat(5000))).toEqual({});
    expect(parseNavState(encodeURIComponent("1m/finance|2m/x|1zfoo|0|1"))).toEqual({
      "m/finance": true,
    });
  });

  it("keeps the newest choices when full", () => {
    let s = {};
    for (let i = 0; i < 120; i++) s = setOpen(s, moduleKey(`/m${i}`), true);
    const back = parseNavState(serializeNavState(s));
    expect(Object.keys(back)).toHaveLength(80);
    expect(back["m/m119"]).toBe(true);
    expect(back["m/m0"]).toBeUndefined();
  });

  it("defaults: a module is open only while inside it, sections and groups are open", () => {
    expect(isOpen({}, moduleKey("/finance"), true)).toBe(true);
    expect(isOpen({}, moduleKey("/finance"), false)).toBe(false);
    expect(isOpen({ "m/finance": true }, moduleKey("/finance"), false)).toBe(true);
    expect(isOpen({}, groupKey("Today"), true)).toBe(true);
  });

  it("re-opens the module, section and group you move into", () => {
    const s = {
      "m/finance": false,
      "s/finance>Money": false,
      gToday: false,
      "m/settings": false,
    };
    const next = revealActive(s, { module: "/finance", section: "/finance>Money", group: "Today" });
    expect(next).toEqual({ "m/settings": false });
    expect(revealActive(next, { module: "/finance" })).toBe(next); // unchanged → same object
  });

  it("expand all opens every module and shows every section and group; collapse all closes modules only", () => {
    const s = { "s/finance>Money": false, gToday: false, "m/settings": false };
    expect(expandAll(s, ["/finance", "/settings"])).toEqual({
      "m/finance": true,
      "m/settings": true,
    });
    expect(collapseAll(s, ["/finance", "/settings"])).toEqual({
      "s/finance>Money": false,
      gToday: false,
      "m/finance": false,
      "m/settings": false,
    });
  });
});

describe("app layout stays query-free", () => {
  it("reads cookies and builds the tree without touching the database", () => {
    const src = readFileSync(join(process.cwd(), "app/(app)/layout.tsx"), "utf8");
    expect(src).toContain("buildNavTree(");
    expect(src).toContain("NAV_STATE_COOKIE");
    for (const banned of [
      "createClient",
      "createAdminClient",
      ".from(",
      ".rpc(",
      "loadFinanceBadges",
    ])
      expect(src, banned).not.toContain(banned);
  });
});

describe("role-limited menu items", () => {
  const hrefs = (roleName: string, perms: string[]) =>
    buildNavTree(NAV_ITEMS, NAV_MODULES, { ...member(perms), roleName }).map((n) => n.href);

  it("shows My day only to doctors and the Medical Director, still behind appointments.view", () => {
    expect(hrefs("Doctor", ["appointments.view"])).toContain("/my-day");
    expect(hrefs("Medical Director", ["appointments.view"])).toContain("/my-day");
    expect(hrefs("Receptionist", ["appointments.view"])).not.toContain("/my-day");
    expect(hrefs("Admin", ["*"])).not.toContain("/my-day");
    expect(hrefs("Doctor", [])).not.toContain("/my-day");
  });

  it("the top bar picks a query entry only on its own query", () => {
    const tree = buildNavTree(NAV_ITEMS, NAV_MODULES, { ...member(["*"]), roleName: "Admin" });
    const branches = "/settings/appointments?tab=locations";
    expect(activeTrail(tree, "/settings/appointments", "?tab=locations").item).toBe(branches);
    expect(activeTrail(tree, "/settings/appointments", "?tab=hours").item).not.toBe(branches);
  });
});
