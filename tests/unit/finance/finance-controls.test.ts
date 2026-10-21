/**
 * The finance controls confirmed by management on 16 Oct 2026 (docs/42_FINANCE_CONTROLS_2026_10.md): Revenue &
 * Collections and Costs & Expenses each work inside their own scope; only the Finance Manager consolidates, signs and
 * circulates the clinic-wide P&L.
 */
import { describe, expect, it } from "vitest";

import { SYSTEM_ROLES } from "@/lib/auth/permissions";
import { landingPathFor } from "@/lib/shell/landing";

const perms = (name: string) => {
  const r = SYSTEM_ROLES.find((x) => x.name === name);
  if (!r) throw new Error(`no role ${name}`);
  return r.permissions;
};

/** Seeing, approving, signing, packing or circulating the clinic-wide P&L, and pay. */
const CONSOLIDATE_OR_CIRCULATE = [
  "reports.view",
  "finance.profit.view",
  "finance.profit.approve",
  "finance.costs.compensation",
  "finance.close.manage",
  "finance.close.signoff.finance",
  "finance.close.signoff.ceo",
  "finance.report_emails.manage",
  "finance.parallel_run.manage",
  "finance.group_pack.export",
  "finance.export.run",
  "finance.bank.signoff",
  "accounting.reports.view",
  "accounting.ledger.view",
];

describe("finance controls (16 Oct 2026)", () => {
  it("keeps Revenue & Collections and Costs & Expenses out of the consolidated P&L", () => {
    for (const role of ["Revenue & Collections", "Costs & Expenses"])
      for (const key of CONSOLIDATE_OR_CIRCULATE)
        expect(perms(role), `${role} ${key}`).not.toContain(key);
  });

  it("keeps each submitter inside their own scope", () => {
    const revenue = perms("Revenue & Collections");
    const costs = perms("Costs & Expenses");
    expect(revenue.filter((k) => k.startsWith("finance.costs."))).toEqual([]);
    expect(revenue.filter((k) => k.startsWith("finance.vouchers."))).toEqual([]);
    expect(costs.filter((k) => k.startsWith("finance.revenue."))).toEqual([]);
    expect(costs).not.toContain("finance.cashup.manage");
    expect(costs).not.toContain("finance.bank.manage");
    expect(revenue).toEqual(
      expect.arrayContaining(["finance.revenue.import", "finance.cashup.manage"]),
    );
    expect(costs).toEqual(
      expect.arrayContaining(["finance.payables.manage", "finance.labs.manage"]),
    );
  });

  it("lets the Finance Manager consolidate, sign and circulate", () => {
    expect(perms("Finance Manager")).toEqual(
      expect.arrayContaining([
        "finance.profit.view",
        "finance.close.manage",
        "finance.close.signoff.finance",
        "finance.report_emails.manage",
        "finance.group_pack.export",
      ]),
    );
    // docs/51: the group pack carries the clinic-wide P&L, so the Finance preset does not hold it
    expect(perms("Finance")).not.toContain("finance.group_pack.export");
    // the final approval and lock stays with the CEO
    expect(perms("CEO")).toContain("finance.close.signoff.ceo");
    expect(perms("Finance Manager")).not.toContain("finance.close.signoff.ceo");
  });

  it("lands both submitters on a finance page they can open", () => {
    for (const role of ["Revenue & Collections", "Costs & Expenses"]) {
      const path = landingPathFor({ status: "active", permissions: perms(role), roleName: role });
      expect(path.startsWith("/finance")).toBe(true);
    }
  });
});

describe("the migration seeds the same roles as the code", () => {
  it("has identical permission lists in 20261209000300", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("supabase/migrations/20261209000300_finance_controls.sql", "utf8");
    for (const role of ["Revenue & Collections", "Costs & Expenses"]) {
      const at = sql.indexOf(`'${role}'`);
      expect(at, role).toBeGreaterThan(0);
      const json = /'(\[[^']*\])'::jsonb/.exec(sql.slice(at))?.[1];
      // the matching keys were added to these roles later (20261221000200, tested in finance-matching-v2.test.ts)
      expect(JSON.parse(json ?? "null"), role).toEqual(
        perms(role).filter((p) => !p.startsWith("finance.matching.")),
      );
    }
  });
});
