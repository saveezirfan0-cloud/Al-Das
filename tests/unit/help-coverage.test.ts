import { describe, expect, it } from "vitest";

import { NAV_ITEMS } from "@/components/shell/nav";
import { SETTINGS_PAGES } from "@/components/shell/settings-pages";
import { GUIDES } from "@/lib/help/guides";
import { NAV_MODULES } from "@/lib/nav/modules";

/**
 * Phase D: every page in a menu has its own one-page guide (the "?" button), not just its module's general one.
 * A page is covered when the guide that matches it most closely was written for it or for a group of pages it belongs
 * to, rather than only for a whole module (/finance, /accounting, /settings, /portal). Module landing pages are covered
 * by their own module guide.
 *
 * ALLOWED lists pages that may rely on the general guide, each with the reason. Keep it short.
 */
const MODULE_ROOTS = ["/finance", "/accounting", "/settings", "/portal"];

const ALLOWED: Record<string, string> = {
  // (none at the moment; add "<path>": "<reason>" only for a page that truly needs no guide of its own)
};

function bestPrefix(path: string): string | null {
  let best: string | null = null;
  for (const g of GUIDES)
    for (const p of g.pages)
      if ((path === p || path.startsWith(p + "/")) && (!best || p.length > best.length)) best = p;
  return best;
}

function menuPaths(): string[] {
  const out = new Set<string>();
  for (const i of NAV_ITEMS) out.add(i.href.split("?")[0]);
  for (const entries of Object.values(NAV_MODULES))
    for (const e of entries) {
      out.add(e.href);
      for (const t of e.tabs ?? []) out.add(t.href);
    }
  for (const p of SETTINGS_PAGES) out.add(p.href);
  return [...out].sort();
}

describe("help coverage", () => {
  it("gives every menu, tab and settings page a guide of its own", () => {
    const missing = menuPaths().filter((path) => {
      if (ALLOWED[path]) return false;
      const p = bestPrefix(path);
      if (!p) return true;
      return MODULE_ROOTS.includes(p) && p !== path;
    });
    expect(missing).toEqual([]);
  });

  it("keeps the allow-list honest: every entry has a reason and is still a menu page", () => {
    const paths = new Set(menuPaths());
    for (const [path, reason] of Object.entries(ALLOWED)) {
      expect(paths.has(path), path).toBe(true);
      expect(reason.length, path).toBeGreaterThan(10);
    }
  });

  it("has unique guide ids and no page claimed by two guides", () => {
    const ids = GUIDES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const pages = GUIDES.flatMap((g) => g.pages);
    expect(pages.filter((p, i) => pages.indexOf(p) !== i)).toEqual([]);
  });
});
