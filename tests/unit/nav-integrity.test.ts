import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NAV_GROUPS, NAV_ITEMS } from "@/components/shell/nav";
import { NAV_MODULES } from "@/lib/nav/modules";

// Every menu link must open a real page, and every page must sit under exactly one menu entry, so the desktop rail,
// its flyouts and the phone drawer never show a dead link or a duplicate.

const APP = path.join(process.cwd(), "app", "(app)");
const pageExists = (href: string) => {
  const clean = href.split(/[?#]/)[0];
  return existsSync(path.join(APP, clean, "page.tsx"));
};

const moduleHrefs = Object.entries(NAV_MODULES).flatMap(([top, entries]) =>
  entries.map((e) => ({ top, href: e.href, label: e.label })),
);

describe("navigation integrity", () => {
  it("every top-level item opens a page", () => {
    const missing = NAV_ITEMS.filter((i) => !pageExists(i.href)).map((i) => i.href);
    expect(missing).toEqual([]);
  });

  it("every module page opens a page and lives under its module", () => {
    const missing = moduleHrefs.filter((e) => !pageExists(e.href)).map((e) => e.href);
    expect(missing).toEqual([]);
    const outside = moduleHrefs.filter((e) => !e.href.startsWith(e.top)).map((e) => e.href);
    expect(outside).toEqual([]);
  });

  it("has no duplicate links or labels within a menu", () => {
    const dupes = (xs: string[]) => xs.filter((x, i) => xs.indexOf(x) !== i);
    expect(dupes(NAV_ITEMS.map((i) => i.href))).toEqual([]);
    expect(dupes(NAV_ITEMS.map((i) => i.label))).toEqual([]);
    for (const entries of Object.values(NAV_MODULES)) {
      expect(dupes(entries.map((e) => e.href))).toEqual([]);
    }
  });

  it("every module is a top-level item, and every grouped item uses a known group", () => {
    const tops = new Set(NAV_ITEMS.map((i) => i.href));
    expect(Object.keys(NAV_MODULES).filter((k) => !tops.has(k))).toEqual([]);
    expect(NAV_ITEMS.filter((i) => i.group && !NAV_GROUPS.includes(i.group))).toEqual([]);
  });
});
