/**
 * Phase G: the finance reports hub (pure). Cards are gated by each report's own key and their links carry only the query
 * parameters the target page (or export route) reads.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PAYABLES_READ, RECEIVABLES_READ } from "@/lib/accounting/nav";
import { REPORT_PERMISSIONS } from "@/lib/accounting/statements/server";
import type { MemberLike } from "@/lib/auth/can";
import { FINANCE_ROLES, ACCOUNTING_ROLES, PERMISSION_KEYS } from "@/lib/auth/permissions";
import { FINANCE_NAV, financeLanding } from "@/lib/finance/nav";
import {
  cardEmail,
  cardLinks,
  currentKey,
  HUB_NAV_PERMISSIONS,
  HUB_PERMISSIONS,
  hubBranches,
  hubCardsFor,
  hubContext,
  hubQuery,
  parseHubParams,
  periodOptions,
  periodRange,
  previousKey,
  REPORT_CARDS,
  type HubPicker,
} from "@/lib/finance/reports-hub";

const member = (permissions: readonly string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions: [...permissions],
});
const role = (name: string) =>
  [...FINANCE_ROLES, ...ACCOUNTING_ROLES].find((r) => r.name === name)!.permissions;

const TODAY = "2026-10-14";
const ctxFor = (p: Partial<HubPicker> = {}) =>
  hubContext(
    { branch: null, kind: "month", key: "2026-09", compare: false, ...p },
    TODAY,
    "2026-10-13",
  );
const card = (key: string) => REPORT_CARDS.find((c) => c.key === key)!;
const params = (href: string) => Object.fromEntries(new URL(href, "https://x.test").searchParams);
const path = (href: string) => new URL(href, "https://x.test").pathname;

describe("periods", () => {
  it("gives the first and last day of a month, quarter and year", () => {
    expect(periodRange("month", "2026-02")).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
      fromMonth: "2026-02",
      toMonth: "2026-02",
      label: "February 2026",
    });
    expect(periodRange("month", "2028-02")?.to).toBe("2028-02-29");
    expect(periodRange("quarter", "2026-Q3")).toMatchObject({
      from: "2026-07-01",
      to: "2026-09-30",
      fromMonth: "2026-07",
      toMonth: "2026-09",
    });
    expect(periodRange("year", "2026")).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodRange("month", "2026-13")).toBeNull();
    expect(periodRange("quarter", "2026-Q5")).toBeNull();
    expect(periodRange("year", "26")).toBeNull();
  });

  it("steps back across year ends and lists the current period first", () => {
    expect(currentKey("quarter", TODAY)).toBe("2026-Q4");
    expect(previousKey("month", "2026-01")).toBe("2025-12");
    expect(previousKey("quarter", "2026-Q1")).toBe("2025-Q4");
    expect(previousKey("year", "2026")).toBe("2025");
    expect(periodOptions("month", TODAY, 3).map((o) => o.key)).toEqual([
      "2026-10",
      "2026-09",
      "2026-08",
    ]);
  });

  it("parses the picker, refusing periods it does not offer and branches the member may not pick", () => {
    expect(parseHubParams({}, TODAY, ["G", "J"], "J")).toEqual({
      branch: "J",
      kind: "month",
      key: "2026-10",
      compare: false,
    });
    expect(
      parseHubParams(
        { period: "quarter", key: "2026-Q3", branch: "all", compare: "1" },
        TODAY,
        ["G"],
        "G",
      ),
    ).toEqual({
      branch: null,
      kind: "quarter",
      key: "2026-Q3",
      compare: true,
    });
    // a future month, a stale key for the kind, an unknown branch
    expect(parseHubParams({ key: "2026-11", branch: "X" }, TODAY, ["G"], null)).toMatchObject({
      key: "2026-10",
      branch: null,
    });
    expect(parseHubParams({ period: "year", key: "2026-09" }, TODAY, [], null).key).toBe("2026");
  });

  it("clamps a running period to today", () => {
    expect(ctxFor({ key: "2026-10" }).to).toBe(TODAY);
    expect(ctxFor().to).toBe("2026-09-30");
  });
});

describe("branches", () => {
  const fin = [
    { code: "G", name: "Garhoud" },
    { code: "J", name: "Jumeirah" },
    { code: "M", name: "Marina" },
  ];
  const locs = [
    { id: "l-g", branch_code: "g" },
    { id: "l-j", branch_code: "J" },
    { id: "l-x", branch_code: null },
  ];
  it("offers every finance branch to an unrestricted member and opens on the switcher's branch", () => {
    expect(hubBranches(fin, locs, { scope: "all", ids: [], home: null }, "l-g")).toEqual({
      options: fin,
      defaultCode: "G",
    });
  });
  it("offers a restricted member only the codes of their branches", () => {
    const r = hubBranches(fin, locs, { scope: "selected", ids: ["l-j"], home: "l-j" }, null);
    expect(r).toEqual({ options: [{ code: "J", name: "Jumeirah" }], defaultCode: null });
  });
});

describe("cards", () => {
  it("every card points at a page that exists, uses real keys, and its export routes exist", () => {
    for (const c of REPORT_CARDS) {
      expect(existsSync(join(process.cwd(), "app/(app)", c.href, "page.tsx")), c.href).toBe(true);
      for (const p of c.permissions) expect(PERMISSION_KEYS, `${c.key} ${p}`).toContain(p);
      for (const e of c.exports ?? [])
        expect(
          existsSync(join(process.cwd(), "app", e.href, "route.ts")) ||
            existsSync(
              join(process.cwd(), "app", e.href.replace(/\/[^/]+$/, "/[report]"), "route.ts"),
            ),
          e.href,
        ).toBe(true);
    }
    expect(new Set(REPORT_CARDS.map((c) => c.key)).size).toBe(REPORT_CARDS.length);
  });

  it("is gated by each report's own key (the one its page checks)", () => {
    const pageKeys: Record<string, string> = {
      flash: "finance.flash.view",
      summary: "finance.view",
      revenue: "finance.revenue.view",
      branches: "finance.view",
      profitability: "finance.profit.view",
      "trial-balance": "accounting.reports.view",
      "insurance-ageing": "finance.claims.view",
      scorecards: "finance.scorecards.view",
      forecast: "finance.forecast.view",
      denials: "finance.denials.manage",
    };
    for (const [key, perm] of Object.entries(pageKeys)) {
      expect(card(key).permissions, key).toContain(perm);
      const src = readFileSync(
        join(process.cwd(), "app/(app)", card(key).href, "page.tsx"),
        "utf8",
      );
      expect(src, key).toContain(`"${perm}"`);
    }
    for (const report of [
      "profit-and-loss",
      "balance-sheet",
      "cash-flow",
      "budget-vs-actual",
      "ratios",
      "vat-return",
      "corporate-tax",
    ] as const)
      expect([...card(report).permissions], report).toEqual([...REPORT_PERMISSIONS[report]]);
    expect([...card("customer-ageing").permissions]).toEqual([...RECEIVABLES_READ]);
    expect([...card("payables-ageing").permissions]).toEqual([...PAYABLES_READ]);
  });

  it("shows the CEO the management and accounting reports but not denials; Billing sees none", () => {
    const ceo = hubCardsFor(member(role("CEO"))).map((c) => c.key);
    expect(ceo).toEqual(
      expect.arrayContaining(["flash", "summary", "profitability", "profit-and-loss", "forecast"]),
    );
    expect(ceo).not.toContain("denials");
    expect(hubCardsFor(member(role("Billing")))).toEqual([]);
    // the Medical Director gets no cost or profit data (CLAUDE.md, F8)
    expect(hubCardsFor(member(role("Medical Director"))).map((c) => c.key)).toEqual([
      "flash",
      "summary",
      "revenue",
      "branches",
      "scorecards",
    ]);
    expect(hubCardsFor(member(role("Cost / Payroll")))).toEqual([]);
    expect(hubCardsFor(member(role("Insurance"))).map((c) => c.key)).toEqual([
      "insurance-ageing",
      "scorecards",
      "denials",
    ]);
    expect(hubCardsFor(member(role("Auditor"))).every((c) => c.group !== "Management")).toBe(true);
    expect(hubCardsFor(member(["contacts.view"]))).toEqual([]);
  });

  it("passes only the parameters each page reads", () => {
    const c = ctxFor({ branch: "G", compare: true });
    expect(params(cardLinks(card("summary"), c).view)).toEqual({
      from: "2026-09",
      to: "2026-09",
      branch: "G",
    });
    expect(params(cardLinks(card("branches"), c).view)).toEqual({ from: "2026-09", to: "2026-09" });
    expect(params(cardLinks(card("revenue"), c).view)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      branch: "G",
      compare: "1",
    });
    expect(params(cardLinks(card("flash"), c).view)).toEqual({ date: "2026-09-30" });
    expect(params(cardLinks(card("flash"), ctxFor({ key: "2026-10" })).view)).toEqual({
      date: "2026-10-13",
    });
    expect(params(cardLinks(card("profit-and-loss"), c).view)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
      compare: "previous",
    });
    expect(params(cardLinks(card("cash-flow"), c).view)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    expect(params(cardLinks(card("budget-vs-actual"), c).view)).toMatchObject({ branch: "G" });
    expect(params(cardLinks(card("customer-ageing"), c).view)).toEqual({ as_of: "2026-09-30" });
    expect(params(cardLinks(card("insurance-ageing"), c).view)).toEqual({ branch: "G" });
    expect(cardLinks(card("forecast"), c).view).toBe("/finance/forecast");
    expect(cardLinks(card("denials"), c).view).toBe("/finance/denials");
    // without a branch or comparison those parameters are left out entirely
    expect(params(cardLinks(card("revenue"), ctxFor()).view)).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  it("links downloads to the existing export routes in the right format", () => {
    const pl = cardLinks(card("profit-and-loss"), ctxFor());
    expect(pl.exports.map((e) => [e.label, path(e.href), params(e.href).format])).toEqual([
      ["Excel", "/api/accounting/reports/profit-and-loss", "xlsx"],
      ["PDF", "/api/accounting/reports/profit-and-loss", "pdf"],
    ]);
    expect(cardLinks(card("trial-balance"), ctxFor()).exports[0].href).toBe(
      "/api/accounting/trial-balance?from=2026-09-01&to=2026-09-30",
    );
    expect(cardLinks(card("branches"), ctxFor()).exports).toEqual([]);
  });

  it("Phase G: the flash and the summary have PDF downloads and an e-mail of the same period", () => {
    const c = ctxFor({ branch: "G" });
    expect(
      cardLinks(card("flash"), c).exports.map((e) => [e.label, path(e.href), params(e.href)]),
    ).toEqual([
      ["Excel", "/api/finance/flash", { date: "2026-09-30" }],
      ["PDF", "/api/finance/flash", { date: "2026-09-30", format: "pdf" }],
    ]);
    expect(
      cardLinks(card("summary"), c).exports.map((e) => [e.label, params(e.href).format ?? "csv"]),
    ).toEqual([
      ["Excel", "xlsx"],
      ["PDF", "pdf"],
      ["CSV", "csv"],
    ]);
    // the export routes read format (and only the parameters they already read)
    for (const route of ["app/api/finance/flash/route.ts", "app/api/finance/summary/route.ts"])
      expect(readFileSync(join(process.cwd(), route), "utf8")).toContain('get("format")');
    expect(cardEmail(card("flash"), c)).toEqual({ report: "daily_flash", day: "2026-09-30" });
    expect(cardEmail(card("flash"), ctxFor({ key: "2026-10" }))).toEqual({
      report: "daily_flash",
      day: "2026-10-13",
    });
    expect(cardEmail(card("summary"), c)).toEqual({
      report: "monthly_summary",
      from: "2026-09",
      to: "2026-09",
      branch: "G",
    });
    expect(cardEmail(card("profit-and-loss"), c)).toBeNull();
    // each e-mailing card is gated by the key the e-mail checks
    expect(card("flash").permissions).toContain("finance.flash.view");
    expect(card("summary").permissions).toContain("finance.view");
  });

  it("round-trips its own query string", () => {
    const p: HubPicker = { branch: "G", kind: "quarter", key: "2026-Q2", compare: true };
    expect(
      parseHubParams(Object.fromEntries(new URLSearchParams(hubQuery(p))), TODAY, ["G"], null),
    ).toEqual(p);
  });
});

describe("menu", () => {
  it("lists the hub first under Overview, for finance reporting keys only", () => {
    expect(FINANCE_NAV[0]).toMatchObject({ href: "/finance/reports", section: "Reports" });
    for (const k of HUB_NAV_PERMISSIONS) expect(HUB_PERMISSIONS).toContain(k);
    expect(HUB_NAV_PERMISSIONS.every((k) => k.startsWith("finance."))).toBe(true);
    expect(financeLanding(member(role("CEO")))).toBe("/finance/reports");
    expect(financeLanding(member(["finance.denials.manage"]))).toBe("/finance/denials");
  });
});
