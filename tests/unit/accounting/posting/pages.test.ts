/**
 * Phase 22D: who sees the posting pages, the guide, the error sentences and the preview comparison (pure).
 */
import { describe, expect, it } from "vitest";

import { ACCOUNTING_ERRORS } from "@/lib/accounting/errors";
import type { MemberLike } from "@/lib/auth/can";
import { accountingNavFor } from "@/lib/accounting/nav";
import { comparePreview } from "@/lib/accounting/posting/preview";
import { REASON_CODES } from "@/lib/accounting/posting/types";
import { ACCOUNTING_ROLES, FINANCE_ROLES } from "@/lib/auth/permissions";
import { guideForPath } from "@/lib/help/guides";
import { WHATS_NEW } from "@/lib/help/whats-new";

const role = (name: string) =>
  [...FINANCE_ROLES, ...ACCOUNTING_ROLES].find((r) => r.name === name)!.permissions;
const member = (permissions: readonly string[]): MemberLike => ({
  userId: "u",
  orgId: "o",
  roleId: "r",
  status: "active",
  permissions,
});
const hrefs = (perms: readonly string[]) => accountingNavFor(member(perms)).map((e) => e.href);

describe("posting pages", () => {
  it("the Chief Accountant sees all three; the Accountant waiting and preview, not the rules' edit; the CEO the preview only", () => {
    expect(hrefs(role("Chief Accountant"))).toEqual(
      expect.arrayContaining([
        "/accounting/waiting",
        "/accounting/posting-preview",
        "/accounting/posting-rules",
      ]),
    );
    expect(hrefs(role("Accountant"))).toEqual(
      expect.arrayContaining([
        "/accounting/waiting",
        "/accounting/posting-preview",
        "/accounting/posting-rules",
      ]),
    );
    const ceo = hrefs(role("CEO"));
    expect(ceo).toContain("/accounting/posting-preview");
    expect(ceo).not.toContain("/accounting/waiting");
    expect(hrefs(role("Finance"))).toEqual([]);
  });

  it("each page has the posting guide; the release note is there", () => {
    for (const p of [
      "/accounting/posting-rules",
      "/accounting/waiting",
      "/accounting/posting-preview",
    ])
      expect(guideForPath(p).id).toBe("accounting-posting");
    // presence, not position: slices built in parallel each add a note at the top (22K)
    expect(WHATS_NEW.map((n) => n.id)).toContain("2026-11-09-accounting-posting-engine");
  });

  it("every reason the engine records has a sentence, and so do the ledger-start codes", () => {
    for (const code of [...REASON_CODES, "before_ledger_start", "ledger_start_in_use", "error"])
      expect(ACCOUNTING_ERRORS[code], code).toBeTruthy();
  });
});

describe("preview comparison", () => {
  const rows = [
    {
      account_id: "a",
      code: "4100",
      name: "Consultation revenue",
      month: "2027-06-01",
      preview: -100,
      ledger: -100,
      difference: 0,
    },
    {
      account_id: "b",
      code: "1210",
      name: "Patient receivable",
      month: "2027-06-01",
      preview: 0,
      ledger: 100,
      difference: -100,
    },
    {
      account_id: "b",
      code: "1210",
      name: "Patient receivable",
      month: "2027-05-01",
      preview: 50.004,
      ledger: 50,
      difference: 0.004,
    },
    {
      account_id: "c",
      code: "1100-P",
      name: "Cash - P",
      month: "2027-06-01",
      preview: 100,
      ledger: 0,
      difference: 100,
    },
  ];

  it("groups by account and month and keeps only the differences when asked", () => {
    const all = comparePreview(rows, { onlyDifferences: false });
    expect(all.months).toEqual(["2027-05-01", "2027-06-01"]);
    expect(all.accounts.map((a) => [a.code, a.months.map((m) => m.month)])).toEqual([
      ["1100-P", ["2027-06-01"]],
      ["1210", ["2027-05-01", "2027-06-01"]],
      ["4100", ["2027-06-01"]],
    ]);
    const diff = comparePreview(rows, { onlyDifferences: true });
    expect(
      diff.accounts.map((a) => [a.code, a.months.map((m) => [m.month, m.difference])]),
    ).toEqual([
      ["1100-P", [["2027-06-01", 100]]],
      ["1210", [["2027-06-01", -100]]],
    ]);
    expect(diff.totals.accountsWithDifference).toBe(2);
  });
});
