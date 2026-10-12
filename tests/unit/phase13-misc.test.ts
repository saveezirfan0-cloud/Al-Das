import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { checkBudgets, parseBuildOutput, type BudgetConfig } from "@/lib/build/bundle-budget";
import { pullState, swipeCommit, swipeIntent, swipeOffset } from "@/lib/hooks/gestures";
import { keyboardOpenFor } from "@/lib/hooks/use-visual-viewport";
import { pushSupport, urlBase64ToUint8Array } from "@/lib/push/client";
import { parseDashboardOverview } from "@/lib/reports/dashboard-tiles";
import { AUTH_MODE_HEADER, authModeFor, isAuthMode } from "@/lib/supabase/auth-mode";
import { stripBadge, withBadge } from "@/lib/shell/title-badge";

describe("tab title badge", () => {
  it("adds, replaces and removes the unread count", () => {
    expect(withBadge("Inbox · Pulse", 3)).toBe("(3) Inbox · Pulse");
    expect(withBadge("(3) Inbox · Pulse", 5)).toBe("(5) Inbox · Pulse");
    expect(withBadge("(3) Inbox · Pulse", 0)).toBe("Inbox · Pulse");
    expect(withBadge("Inbox", 250)).toBe("(99+) Inbox");
    expect(withBadge("Inbox", Number.NaN)).toBe("Inbox");
    expect(stripBadge("(12) Tasks")).toBe("Tasks");
    expect(stripBadge("(not a badge) Tasks")).toBe("(not a badge) Tasks");
  });
});

describe("touch gestures", () => {
  it("tells a sideways swipe from a vertical scroll", () => {
    expect(swipeIntent(3, 2)).toBe("pending");
    expect(swipeIntent(40, 5)).toBe("horizontal");
    expect(swipeIntent(10, 40)).toBe("vertical");
    expect(swipeIntent(30, 25)).toBe("vertical"); // diagonal drags stay scrolls
    expect(swipeIntent(-60, 10)).toBe("horizontal");
  });

  it("commits a swipe only past the threshold, in the right direction", () => {
    expect(swipeCommit(120)).toBe("right");
    expect(swipeCommit(-120)).toBe("left");
    expect(swipeCommit(50)).toBeNull();
    expect(swipeCommit(-95)).toBeNull();
    expect(swipeCommit(96)).toBe("right");
  });

  it("resists past the maximum drag", () => {
    expect(swipeOffset(60)).toBe(60);
    expect(swipeOffset(-60)).toBe(-60);
    expect(swipeOffset(240)).toBeLessThan(240);
    expect(swipeOffset(240)).toBeGreaterThan(140);
  });

  it("pull to refresh needs the list at the very top and a long enough downward drag", () => {
    expect(pullState({ startY: 100, currentY: 120, scrollTop: 0 }).ready).toBe(false);
    expect(pullState({ startY: 100, currentY: 220, scrollTop: 0 })).toMatchObject({ ready: true });
    expect(pullState({ startY: 100, currentY: 220, scrollTop: 40 })).toEqual({
      distance: 0,
      ready: false,
    });
    expect(pullState({ startY: 100, currentY: 80, scrollTop: 0 })).toEqual({
      distance: 0,
      ready: false,
    });
    expect(pullState({ startY: 0, currentY: 1000, scrollTop: 0 }).distance).toBe(96);
  });

  it("notices the on-screen keyboard from the visual viewport", () => {
    expect(keyboardOpenFor(800, 800)).toBe(false);
    expect(keyboardOpenFor(800, 760)).toBe(false); // browser chrome moving
    expect(keyboardOpenFor(800, 480)).toBe(true);
  });
});

describe("push client helpers", () => {
  it("decodes a URL-safe base64 VAPID key to bytes", () => {
    const bytes = urlBase64ToUint8Array(
      "BLUpUx6SeKpVhkqT_16lNKwtq9wc7IcQFSatGpDrGB95cFZ_4qgVDURlBfR7gqsgCt1slMsbJbNEMbBTnsirwwI",
    );
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4); // uncompressed EC point marker
  });

  it("explains iOS (home screen needed) instead of calling it unsupported", () => {
    const base = {
      hasServiceWorker: true,
      hasPushManager: true,
      hasNotification: true,
      isIos: false,
      isStandalone: false,
    };
    expect(pushSupport(base)).toBe("supported");
    expect(pushSupport({ ...base, isIos: true })).toBe("needs_install");
    expect(pushSupport({ ...base, isIos: true, isStandalone: true })).toBe("supported");
    expect(pushSupport({ ...base, hasServiceWorker: false })).toBe("no_service_worker");
    expect(pushSupport({ ...base, hasPushManager: false })).toBe("no_push");
  });
});

describe("dashboard overview parsing", () => {
  it("reads the SQL function's JSON", () => {
    const parsed = parseDashboardOverview({
      conversations: { mine: 3, unassigned: 2, waiting: 1, unread_mine: 4 },
      team: { members: 9, online: 5 },
      tasks: { open: 7, overdue: 2 },
      enquiries: { open: 11, new_today: 3 },
    });
    expect(parsed.conversations).toEqual({ mine: 3, unassigned: 2, waiting: 1, unread_mine: 4 });
    expect(parsed.tasks).toEqual({ open: 7, overdue: 2 });
    expect(parsed.enquiries).toEqual({ open: 11, new_today: 3 });
  });

  it("treats a hidden section as absent and a broken response as zeros, never a crash", () => {
    const hidden = parseDashboardOverview({
      conversations: { mine: 1 },
      team: { members: 1, online: 0 },
      tasks: null,
      enquiries: null,
    });
    expect(hidden.tasks).toBeNull();
    expect(hidden.conversations.mine).toBe(1);
    expect(parseDashboardOverview(null).conversations).toEqual({
      mine: 0,
      unassigned: 0,
      waiting: 0,
      unread_mine: 0,
    });
    expect(parseDashboardOverview("garbage").team).toEqual({ members: 0, online: 0 });
    expect(parseDashboardOverview({ conversations: { mine: "lots" } }).conversations.mine).toBe(0);
  });
});

describe("auth mode", () => {
  const page = { method: "GET", pathname: "/inbox", hasServerActionHeader: false };
  it("verifies page navigations locally and everything that can change data with Supabase Auth", () => {
    expect(authModeFor(page)).toBe("claims");
    expect(authModeFor({ ...page, method: "HEAD" })).toBe("claims");
    expect(authModeFor({ ...page, method: "POST" })).toBe("strict");
    expect(authModeFor({ ...page, method: "PATCH" })).toBe("strict");
    expect(authModeFor({ ...page, hasServerActionHeader: true })).toBe("strict");
    expect(authModeFor({ ...page, pathname: "/api/contacts/export" })).toBe("strict");
    expect(authModeFor({ ...page, pathname: "/api" })).toBe("strict");
    expect(authModeFor({ ...page, pathname: "/apiary" })).toBe("claims");
    expect(authModeFor({ ...page, optOut: true })).toBe("strict");
  });
  it("only accepts the two modes from a header", () => {
    expect(AUTH_MODE_HEADER).toBe("x-pulse-auth");
    expect(isAuthMode("claims")).toBe(true);
    expect(isAuthMode("strict")).toBe(true);
    expect(isAuthMode("lax")).toBe(false);
    expect(isAuthMode(null)).toBe(false);
  });
});

// The route table `next build` printed before Phase 13 (docs/13_PHASE_13_NOTES.md), trimmed.
const BASELINE = `
Route (app)                              Size  First Load JS
├ ƒ /appointments                          97 kB         309 kB
├ ƒ /campaigns                           4.73 kB         147 kB
├ ○ /icon.svg                                0 B            0 B
├ ƒ /dashboard                             188 B         232 kB
├ ƒ /flows/[id]                          70.9 kB         278 kB
├ ƒ /inbox                               25.8 kB         286 kB
├ ƒ /api/jobs/[queue]                      202 B         102 kB
└ ƒ /templates                           21.4 kB         224 kB
+ First Load JS shared by all             102 kB
  ├ chunks/6466-06a0f2b028b032e8.js        46 kB
`;

describe("bundle budget", () => {
  const config: BudgetConfig = {
    sharedKb: 110,
    defaultKb: 300,
    routes: { "/dashboard": 240, "/inbox": 290, "/appointments": 300 },
  };

  it("parses the route table, including ANSI colours, MB and bytes", () => {
    const parsed = parseBuildOutput(BASELINE);
    expect(parsed.shared).toBe(102);
    expect(parsed.routes.find((r) => r.route === "/appointments")!.firstLoadKb).toBe(309);
    expect(parsed.routes.find((r) => r.route === "/flows/[id]")!.firstLoadKb).toBe(278);
    expect(parsed.routes.find((r) => r.route === "/icon.svg")!.firstLoadKb).toBe(0);
    expect(
      parseBuildOutput(
        "\u001b[1m├ ƒ /x\u001b[22m    1 kB   1.5 MB\n+ First Load JS shared by all  900 B",
      ).routes[0].firstLoadKb,
    ).toBe(1500);
    expect(parseBuildOutput("+ First Load JS shared by all  900 B").shared).toBeCloseTo(0.9);
  });

  it("passes when every route is inside its budget", () => {
    const res = checkBudgets(parseBuildOutput(BASELINE), {
      ...config,
      routes: { ...config.routes, "/appointments": 320, "/flows/[id]": 300 },
    });
    expect(res.violations).toEqual([]);
    expect(res.ok).toBe(true);
    expect(res.report.join("\n")).toContain("/inbox: 286.0 kB (budget 290 kB)");
  });

  it("fails on a budgeted route over its budget, an unbudgeted route over the default, and a fat shared bundle", () => {
    const res = checkBudgets(parseBuildOutput(BASELINE), {
      sharedKb: 100,
      defaultKb: 200,
      routes: { "/appointments": 300 },
    });
    expect(res.ok).toBe(false);
    expect(res.violations.join("\n")).toContain("shared JS is 102.0 kB, budget 100 kB");
    expect(res.violations.join("\n")).toContain(
      "/appointments first load is 309.0 kB, budget 300 kB",
    );
    expect(res.violations.join("\n")).toContain("/inbox first load is 286.0 kB, budget 200 kB");
  });

  it("fails loudly on a log that is not a build, and on a stale budget entry", () => {
    expect(checkBudgets(parseBuildOutput("npm ERR!"), config).ok).toBe(false);
    const stale = checkBudgets(parseBuildOutput(BASELINE), {
      ...config,
      routes: { ...config.routes, "/gone": 100, "/appointments": 320 },
    });
    expect(stale.unknownBudgetRoutes).toEqual(["/gone"]);
    expect(stale.ok).toBe(false);
  });

  it("the committed budget file is valid and covers the five tracked routes", () => {
    const file = JSON.parse(
      readFileSync(path.join(process.cwd(), "scripts/bundle-budget.json"), "utf8"),
    ) as BudgetConfig;
    expect(file.sharedKb).toBeGreaterThan(0);
    expect(file.defaultKb).toBeGreaterThan(0);
    for (const r of ["/dashboard", "/appointments", "/inbox", "/flows/[id]"])
      expect(file.routes[r], r).toBeGreaterThan(0);
  });
});
