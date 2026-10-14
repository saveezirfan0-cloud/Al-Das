import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseCsv } from "@/lib/csv";
import {
  BULK_LIMIT,
  bulkEligible,
  CHANGE_KINDS,
  changeKpi,
  changesCsv,
  DECISIONS,
  defaultPeriod,
  isUnapproved,
  KIND_LABELS,
  MAX_PERIOD_DAYS,
  needsApproval,
  parseChanges,
  periodProblem,
  reviewOrder,
  statusLabel,
  totalsByKind,
  type ChangeEvent,
} from "@/lib/finance/invoice-changes";

import fixture from "./fixtures/invoice-changes.synthetic.json";

const reg = parseChanges(fixture);
const key = (n: number) => n.toString().padStart(32, "0");
const ev = (n: number) => reg.events.find((e) => e.changeKey === key(n))!;
const keys = (events: readonly ChangeEvent[]) => events.map((e) => Number(e.changeKey));

describe("invoice-change register (Phase 20J)", () => {
  it("reads the SQL result, dropping unknown kinds and reading an unknown decision as no review (fail closed)", () => {
    expect(reg).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-31",
      startDate: "2026-10-05",
      minAmount: 25,
      bulkMax: 100,
    });
    expect(reg.events).toHaveLength(9);
    expect(reg.events.some((e) => e.invoiceNo === "SYN-INV-6")).toBe(false);
    expect(ev(10).review).toBeNull();
    expect(ev(4).review).toMatchObject({
      decision: "rejected",
      reason: "Not authorised",
      bulk: false,
    });
    expect(ev(7)).toMatchObject({
      kind: "refund",
      amount: 120,
      monthLocked: true,
      uniteUser: null,
    });
    expect(ev(8).amount).toBe(99.5);
    expect(parseChanges(null)).toMatchObject({
      startDate: null,
      minAmount: 0,
      bulkMax: 0,
      events: [],
    });
  });

  it("labels every kind and decision, and the kinds match the database's list", () => {
    for (const k of CHANGE_KINDS) expect(KIND_LABELS[k]).toBeTruthy();
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20261031000100_finance_invoice_changes.sql"),
      "utf8",
    );
    const kinds = /kind text not null check \(kind in \(([^)]*)\)\)/.exec(sql)?.[1];
    expect(kinds?.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...CHANGE_KINDS]);
    const decisions = /decision text not null check \(decision in \(([^)]*)\)\)/.exec(sql)?.[1];
    expect(decisions?.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...DECISIONS]);
  });

  it("a change needs approval from the minimum amount (0 = every change)", () => {
    expect(needsApproval({ amount: 25 }, { minAmount: 25 })).toBe(true);
    expect(needsApproval({ amount: 24.99 }, { minAmount: 25 })).toBe(false);
    expect(needsApproval({ amount: 0 }, { minAmount: 0 })).toBe(true);
  });

  it("unapproved: needs approval, on or after the start date, unreviewed or not approved", () => {
    const s = { startDate: "2026-10-05", minAmount: 25 };
    expect(isUnapproved(ev(1), s)).toBe(false); // before the start date
    expect(isUnapproved(ev(2), s)).toBe(true); // on the start date, no review
    expect(isUnapproved(ev(3), s)).toBe(false); // approved
    expect(isUnapproved(ev(4), s)).toBe(true); // not approved
    expect(isUnapproved(ev(5), s)).toBe(false); // below the minimum
    expect(isUnapproved(ev(6), s)).toBe(false); // explained
    expect(isUnapproved(ev(2), { startDate: null, minAmount: 0 })).toBe(false); // not measured
  });

  it("the measure: counts and amounts awaiting review and not approved, from the later of the start date and the period", () => {
    expect(changeKpi(reg)).toEqual({
      measured: true,
      from: "2026-10-05",
      awaiting: { count: 3, amount: 249.5 },
      rejected: { count: 1, amount: 300 },
      unapproved: { count: 4, amount: 549.5 },
    });
    expect(changeKpi({ ...reg, startDate: null })).toEqual({ measured: false });
    expect(changeKpi({ ...reg, startDate: "2026-09-01" })).toMatchObject({
      from: "2026-10-01",
      unapproved: { count: 5, amount: 599.5 },
    });
    expect(changeKpi({ ...reg, startDate: "2026-09-01", minAmount: 0 })).toMatchObject({
      unapproved: { count: 7, amount: 634.5 },
    });
  });

  it("totals per kind, in a fixed order, with the unreviewed count", () => {
    expect(totalsByKind(reg.events)).toEqual([
      { kind: "discount", count: 3, amount: 179.5, unreviewed: 3 },
      { kind: "cancellation", count: 1, amount: 300, unreviewed: 0 },
      { kind: "credit_note", count: 1, amount: 20, unreviewed: 1 },
      { kind: "write_off", count: 1, amount: 60, unreviewed: 0 },
      { kind: "net_reduction", count: 1, amount: 40, unreviewed: 0 },
      { kind: "refund", count: 2, amount: 135, unreviewed: 2 },
    ]);
    expect(totalsByKind([])).toEqual([]);
  });

  it("bulk approval takes unreviewed changes up to the limit only, optionally of one kind, and is off at 0", () => {
    expect(keys(bulkEligible(reg.events, 100))).toEqual([1, 2, 5, 8, 10]);
    expect(keys(bulkEligible(reg.events, 100, "discount"))).toEqual([1, 2, 8]);
    expect(keys(bulkEligible(reg.events, 99.49))).toEqual([1, 2, 5, 10]);
    expect(bulkEligible(reg.events, 0)).toEqual([]);
    expect(bulkEligible(reg.events, Number.NaN)).toEqual([]);
    const many = Array.from({ length: BULK_LIMIT + 5 }, (_, i) => ({
      ...ev(2),
      changeKey: key(100 + i),
    }));
    expect(bulkEligible(many, 100)).toHaveLength(BULK_LIMIT);
  });

  it("review order: unreviewed needing approval, then unreviewed below the minimum, then reviewed; newest first", () => {
    expect(keys(reviewOrder(reg.events, reg))).toEqual([8, 7, 2, 1, 10, 5, 6, 4, 3]);
    expect(statusLabel(ev(2), reg)).toBe("Awaiting review");
    expect(statusLabel(ev(5), reg)).toBe("Below the approval amount");
    expect(statusLabel(ev(4), reg)).toBe("Not approved");
    expect(statusLabel(ev(6), reg)).toBe("No approval needed (explained)");
  });

  it("periods: valid dates, in order, at most a year", () => {
    expect(periodProblem("2026-10-01", "2026-10-31")).toBeNull();
    expect(periodProblem("2026-10-01", "2026-10-01")).toBeNull();
    expect(periodProblem("2026-02-30", "2026-03-01")).toMatch(/valid/);
    expect(periodProblem("2026-10-01", "")).toMatch(/valid/);
    expect(periodProblem("2026-10-02", "2026-10-01")).toMatch(/after/);
    expect(periodProblem("2025-10-01", "2026-09-30")).toBeNull(); // 365 days
    expect(periodProblem("2024-01-01", "2024-12-31")).toBeNull(); // 366 days
    expect(periodProblem("2025-10-01", "2026-10-02")).toMatch(String(MAX_PERIOD_DAYS));
    expect(defaultPeriod("2026-10-13")).toEqual({ from: "2026-10-01", to: "2026-10-13" });
  });

  it("CSV: one row per change with status and reason, amounts to two decimals, formulas neutralised", () => {
    const csv = changesCsv(reg, reviewOrder(reg.events, reg));
    const parsed = parseCsv(csv.replace(/^﻿/, ""));
    expect(parsed.headers).toEqual([
      "Change date",
      "Invoice",
      "Branch",
      "Doctor ID",
      "Invoice type",
      "Change",
      "Amount (AED)",
      "Unite user",
      "Status",
      "Reason",
      "Bulk",
      "Reviewed at",
      "Month locked",
    ]);
    expect(parsed.rows).toHaveLength(9);
    expect(parsed.rows[0]).toEqual([
      "2026-10-12",
      "'=SYN-INV-5",
      "P",
      "",
      "",
      "Discount",
      "99.50",
      "'@unite.dave",
      "Awaiting review",
      "",
      "",
      "",
      "no",
    ]);
    const rejected = parsed.rows.find((r) => r[1] === "SYN-INV-2")!;
    expect(rejected.slice(8)).toEqual([
      "Not approved",
      "Not authorised",
      "no",
      "2026-10-07 08:00",
      "no",
    ]);
    expect(parsed.rows.find((r) => r[5] === "Refund" && r[6] === "120.00")![12]).toBe("yes");
  });
});
