import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RECALL_TABS, recallTabsFor } from "@/app/(app)/recall/tabs";
import { VIEW_PERMS as REVSHARE_VIEW } from "@/app/(app)/finance/revenue-share/tabs";
import { NAV_ITEMS } from "@/components/shell/nav";
import type { MemberLike } from "@/lib/auth/can";
import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { NAV_MODULES } from "@/lib/nav/modules";
import { buildNavTree } from "@/lib/nav/tree";
import { SUB_PAGE_LINKS, subPageLinksFor } from "@/lib/shell/sub-page-links";

// Pages reached only from inside another page are still one Ctrl+K search away, and in-page links never lead a member
// to a page that would refuse them (docs/34 Phase D; nav-qa).

const APP = path.join(process.cwd(), "app", "(app)");
const source = (href: string) => readFileSync(path.join(APP, href, "page.tsx"), "utf8");
const pageGate = (href: string) => /requirePerm\("([^"]+)"\)/.exec(source(href))?.[1] ?? null;
const member = (permissions: readonly string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const role = (name: string) => SYSTEM_ROLES.find((r) => r.name === name)!.permissions;

describe("Ctrl+K sub-page links", () => {
  it("each opens a real page, once, and is not already a menu page", () => {
    const hrefs = SUB_PAGE_LINKS.map((l) => l.href);
    expect(hrefs.filter((h) => !existsSync(path.join(APP, h, "page.tsx")))).toEqual([]);
    expect(hrefs.filter((h, i) => hrefs.indexOf(h) !== i)).toEqual([]);
    const menu = buildNavTree(NAV_ITEMS, NAV_MODULES, member(["*"])).flatMap((n) => [
      n.href,
      ...(n.sections ?? []).flatMap((s) =>
        s.pages.flatMap((p) => [p.href, ...(p.tabs ?? []).map((t) => t.href)]),
      ),
    ]);
    expect(hrefs.filter((h) => menu.includes(h))).toEqual([]);
  });

  it("each is gated by its page's own check", () => {
    for (const l of SUB_PAGE_LINKS) {
      const gate = pageGate(l.href);
      if (gate) expect([...l.anyOf], l.href).toEqual([gate]);
      else if (l.href.startsWith("/finance/revenue-share/"))
        expect([...l.anyOf], l.href).toEqual([...REVSHARE_VIEW]);
      else if (l.href !== "/inbox/failed")
        // no requirePerm: every key in the gate is one the page itself checks
        for (const k of l.anyOf) expect(source(l.href), `${l.href} ${k}`).toContain(`"${k}"`);
    }
  });

  it("shows each role only what it may open", () => {
    const of = (r: string) => subPageLinksFor(member(role(r))).map((l) => l.href);
    expect(of("Receptionist")).toEqual(
      expect.arrayContaining(["/front-desk/end-of-day", "/front-desk/qr", "/inbox/failed"]),
    );
    expect(of("Marketing")).toEqual(
      expect.arrayContaining(["/campaigns/history", "/recall/calls", "/recall/parallel-run"]),
    );
    expect(of("HR")).toEqual([]);
    expect(of("Doctor")).not.toContain("/inbox/failed");
    expect(subPageLinksFor(member(["campaigns.view"])).map((l) => l.href)).not.toContain(
      "/recall/parallel-run",
    );
  });
});

describe("in-page links", () => {
  it("Recall's tabs match their pages' keys, and Parallel run needs reports.view", () => {
    for (const t of RECALL_TABS) expect(pageGate(t.href), t.href).toBe(t.permission);
    expect(recallTabsFor(member(["campaigns.view"])).map((t) => t.href)).toEqual([
      "/recall",
      "/recall/calls",
    ]);
  });

  it("Campaigns offers Manage templates only to members who can open Templates", () => {
    expect(pageGate("/templates")).toBe("templates.manage");
    expect(source("/campaigns")).toMatch(
      /can\(member, "templates\.manage"\) && \(\s*<Button[^]*?href="\/templates"/,
    );
  });
});
