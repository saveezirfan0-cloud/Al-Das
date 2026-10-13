import { describe, expect, it } from "vitest";

import { accountingErrorMessage, rpcErrorMessage } from "@/lib/accounting/errors";
import {
  cleanNarration,
  isManualVoucherType,
  journalTotals,
  parseAmount,
  roundMoney,
  validateJournal,
  type LineCheck,
} from "@/lib/accounting/journal";

const line = (debit: number, credit: number, extra: Partial<LineCheck> = {}): LineCheck => ({
  accountId: "a",
  debit,
  credit,
  isGroup: false,
  isActive: true,
  control: null,
  allowManual: true,
  ...extra,
});
const codes = (lines: LineCheck[], manual = true, voucherType: "journal" | "opening" = "journal") =>
  validateJournal(lines, { manual, voucherType }).map((p) =>
    p.line ? `${p.code}@${p.line}` : p.code,
  );

describe("money helpers", () => {
  it("rounds half away from zero to 2 decimals without floating drift", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(-1.005)).toBe(-1.01);
    expect(roundMoney(10)).toBe(10);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(Number.isNaN(roundMoney(Number.NaN))).toBe(true);
  });

  it("reads amounts typed by people", () => {
    expect(parseAmount("1,234.50")).toBe(1234.5);
    expect(parseAmount("")).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount("12a")).toBeNaN();
    expect(parseAmount("-5")).toBeNaN();
  });

  it("totals in cents (no drift across many lines)", () => {
    const many = Array.from({ length: 10 }, () => ({ debit: 0.1, credit: 0 }));
    expect(journalTotals([...many, { debit: 0, credit: 1 }])).toEqual({
      debit: 1,
      credit: 1,
      difference: 0,
    });
  });
});

describe("validateJournal", () => {
  it("accepts a balanced two-line journal", () => {
    expect(codes([line(100, 0), line(0, 100)])).toEqual([]);
  });

  it("refuses unbalanced, one-line and zero journals", () => {
    expect(codes([line(100, 0), line(0, 99.99)])).toEqual(["unbalanced"]);
    expect(codes([line(100, 0)])).toEqual(["too_few_lines", "unbalanced"]);
    expect(codes([])).toEqual(["too_few_lines"]);
    expect(codes([line(0, 0), line(0, 0)])).toEqual(["one_sided@1", "one_sided@2", "zero_total"]);
  });

  it("refuses a line with both sides, negative amounts or more than 2 decimals", () => {
    expect(codes([line(10, 10), line(0, 0)])).toContain("one_sided@1");
    expect(codes([line(-5, 0), line(0, -5)])).toEqual([
      "bad_amount@1",
      "bad_amount@2",
      "zero_total",
    ]);
    expect(codes([line(1.234, 0), line(0, 1.234)])).toContain("bad_amount@1");
  });

  it("refuses groups, inactive accounts and missing accounts", () => {
    expect(codes([line(5, 0, { isGroup: true }), line(0, 5)])).toEqual(["account_is_group@1"]);
    expect(codes([line(5, 0), line(0, 5, { isActive: false })])).toEqual(["account_inactive@2"]);
    expect(codes([line(5, 0, { accountId: null }), line(0, 5)])).toEqual(["account_not_found@1"]);
  });

  it("keeps control accounts for automatic postings and opening balances", () => {
    const lines = [line(5, 0, { control: "receivable" }), line(0, 5)];
    expect(codes(lines)).toEqual(["control_account@1"]);
    expect(codes(lines, true, "opening")).toEqual([]);
    expect(codes(lines, false)).toEqual([]);
    expect(codes([line(5, 0, { allowManual: false }), line(0, 5)])).toEqual([
      "manual_not_allowed@1",
    ]);
  });

  it("refuses more than 500 lines", () => {
    const lines = Array.from({ length: 501 }, (_, i) => line(i % 2 ? 0 : 1, i % 2 ? 1 : 0));
    expect(codes(lines)).toContain("too_many_lines");
  });
});

describe("narration and errors", () => {
  it("masks card, account and phone numbers and e-mail addresses, and caps the length", () => {
    const n = cleanNarration("Refund card 4111 1111 1111 1111 call 0501234567 a@b.co\nline two");
    expect(n).not.toMatch(/4111 1111/);
    expect(n).not.toMatch(/0501234567/);
    expect(n).toContain("[email]");
    expect(n).not.toContain("\n");
    expect(cleanNarration("x".repeat(400))!.length).toBe(300);
    expect(cleanNarration("   ")).toBeNull();
  });

  it("turns a database hint into a sentence, never the database message", () => {
    expect(accountingErrorMessage("unbalanced", "x")).toMatch(/equal/);
    expect(accountingErrorMessage("nope", "fallback")).toBe("fallback");
    expect(rpcErrorMessage({ code: "23514", hint: "period_locked" }, "x")).toMatch(/locked/);
    expect(rpcErrorMessage({ code: "42501" }, "x")).toMatch(/reverse/);
    expect(rpcErrorMessage(null, "fallback")).toBe("fallback");
  });

  it("knows which voucher types are manual", () => {
    expect(isManualVoucherType("journal")).toBe(true);
    expect(isManualVoucherType("opening")).toBe(true);
    expect(isManualVoucherType("sales")).toBe(false);
  });
});
