/**
 * Phase 22F: the pure banking rules (lib/accounting/banking.ts). The database repeats each rule; the DB suite
 * (tests/db/accounting-banking.test.ts) checks the SQL side. Synthetic values only.
 */
import { describe, expect, it } from "vitest";

import {
  addMonths,
  availableChequeActions,
  BANKING_ERRORS,
  bankingErrorMessage,
  bookToBank,
  CHEQUE_ACTIONS,
  CHEQUE_STATUSES,
  CHEQUE_TRANSITIONS,
  chequeActionProblem,
  entryIsMoneyIn,
  FINAL_CHEQUE_STATUSES,
  isDue,
  isPatientPin,
  isPostDated,
  isStale,
  monthOf,
  nextChequeStatus,
  nextLeaf,
  pettyCashCount,
  postingMessage,
  staleFrom,
  suggestCode,
  suggestedEntryKind,
  topUpNeeded,
  transferProblem,
  vatSplit,
} from "@/lib/accounting/banking";

const bank = (id: string) => ({ id, control: "bank" });
const cash = (id: string) => ({ id, control: "cash" });

describe("transfer validation", () => {
  it("accepts bank to bank, cash deposits, withdrawals and top-ups", () => {
    expect(
      transferProblem({ kind: "transfer", from: bank("a"), to: bank("b"), amount: 100 }),
    ).toBeNull();
    expect(
      transferProblem({ kind: "cash_deposit", from: cash("c"), to: bank("b"), amount: 50.25 }),
    ).toBeNull();
    expect(
      transferProblem({ kind: "cash_withdrawal", from: bank("b"), to: cash("c"), amount: 1 }),
    ).toBeNull();
    expect(
      transferProblem({ kind: "petty_cash_topup", from: bank("b"), to: cash("pc"), amount: 500 }),
    ).toBeNull();
  });

  it("refuses the same account, non-money accounts and the wrong direction", () => {
    expect(transferProblem({ kind: "transfer", from: bank("a"), to: bank("a"), amount: 1 })).toBe(
      "same_account",
    );
    expect(
      transferProblem({
        kind: "transfer",
        from: bank("a"),
        to: { id: "x", control: null },
        amount: 1,
      }),
    ).toBe("not_money_account");
    expect(transferProblem({ kind: "transfer", from: null, to: bank("a"), amount: 1 })).toBe(
      "not_money_account",
    );
    expect(
      transferProblem({ kind: "cash_deposit", from: bank("a"), to: bank("b"), amount: 1 }),
    ).toBe("transfer_direction");
    expect(
      transferProblem({ kind: "cash_withdrawal", from: cash("c"), to: bank("b"), amount: 1 }),
    ).toBe("transfer_direction");
  });

  it("refuses zero, negative and over-precise amounts", () => {
    for (const amount of [0, -5, 1.005, Number.NaN])
      expect(transferProblem({ kind: "transfer", from: bank("a"), to: bank("b"), amount })).toBe(
        "bad_amount",
      );
  });
});

describe("bank entries and VAT", () => {
  it("knows which kinds bring money in", () => {
    expect(entryIsMoneyIn("interest_received")).toBe(true);
    expect(entryIsMoneyIn("direct_credit")).toBe(true);
    expect(entryIsMoneyIn("bank_charge")).toBe(false);
    expect(entryIsMoneyIn("direct_debit")).toBe(false);
    expect(suggestedEntryKind(12)).toBe("direct_credit");
    expect(suggestedEntryKind(-12)).toBe("bank_charge");
  });

  it("splits a VAT-inclusive amount at the standard rate (net rounded, VAT the rest)", () => {
    expect(vatSplit(105, { kind: "standard", rate: 5 })).toEqual({ net: 100, vat: 5 });
    expect(vatSplit(10.5, { kind: "standard", rate: 5 })).toEqual({ net: 10, vat: 0.5 });
    expect(vatSplit(26.25, { kind: "standard", rate: 5 })).toEqual({ net: 25, vat: 1.25 });
    // 1.00 / 1.05 = 0.952... -> 0.95 net, 0.05 VAT
    expect(vatSplit(1, { kind: "standard", rate: 5 })).toEqual({ net: 0.95, vat: 0.05 });
  });

  it("keeps the whole amount without VAT for zero, exempt, out-of-scope and blocked codes", () => {
    expect(vatSplit(80, null)).toEqual({ net: 80, vat: 0 });
    expect(vatSplit(80, { kind: "zero", rate: 0 })).toEqual({ net: 80, vat: 0 });
    expect(vatSplit(80, { kind: "exempt", rate: 0 })).toEqual({ net: 80, vat: 0 });
    expect(vatSplit(80, { kind: "blocked", rate: 5 })).toEqual({ net: 80, vat: 0 });
  });

  it("refuses reverse charge", () => {
    expect(vatSplit(80, { kind: "reverse_charge", rate: 5 })).toBeNull();
  });
});

describe("cheque status machine", () => {
  it("has a transition table matching the SQL (acc_cheque_act)", () => {
    expect(CHEQUE_TRANSITIONS).toEqual({
      present: { from: ["issued", "received"], to: "presented" },
      clear: { from: ["issued", "received", "presented"], to: "cleared" },
      bounce: { from: ["issued", "received", "presented", "cleared"], to: "bounced" },
      cancel: { from: ["issued", "received"], to: "cancelled" },
      stale: { from: ["issued", "received"], to: "stale" },
    });
  });

  it("never leaves a final status", () => {
    for (const s of FINAL_CHEQUE_STATUSES)
      for (const a of CHEQUE_ACTIONS) expect(nextChequeStatus(s, a), `${s} ${a}`).toBeNull();
  });

  it("walks a cheque from issued to cleared and from received to bounced", () => {
    expect(nextChequeStatus("issued", "present")).toBe("presented");
    expect(nextChequeStatus("presented", "clear")).toBe("cleared");
    expect(nextChequeStatus("received", "clear")).toBe("cleared");
    expect(nextChequeStatus("cleared", "bounce")).toBe("bounced");
    expect(nextChequeStatus("presented", "cancel")).toBeNull();
    expect(nextChequeStatus("cleared", "present")).toBeNull();
    expect(CHEQUE_STATUSES).toHaveLength(7);
  });

  it("refuses presenting, clearing or bouncing a post-dated cheque before its date", () => {
    const base = {
      status: "issued" as const,
      chequeDate: "2026-12-15",
      today: "2026-11-10",
      date: "2026-11-10",
    };
    expect(chequeActionProblem({ ...base, action: "present" })).toBe("cheque_not_due");
    expect(chequeActionProblem({ ...base, action: "clear" })).toBe("cheque_not_due");
    expect(chequeActionProblem({ ...base, action: "bounce", reason: "returned" })).toBe(
      "cheque_not_due",
    );
    // cancelling a post-dated cheque before its date is fine
    expect(chequeActionProblem({ ...base, action: "cancel", reason: "not needed" })).toBeNull();
  });

  it("needs a reason to bounce or cancel, and no future dates", () => {
    const base = {
      status: "received" as const,
      chequeDate: "2026-11-01",
      today: "2026-11-10",
      date: "2026-11-05",
    };
    expect(chequeActionProblem({ ...base, action: "bounce", reason: "" })).toBe("remarks_required");
    expect(chequeActionProblem({ ...base, action: "cancel", reason: "ab" })).toBe(
      "remarks_required",
    );
    expect(
      chequeActionProblem({ ...base, action: "bounce", reason: "insufficient funds" }),
    ).toBeNull();
    expect(chequeActionProblem({ ...base, action: "clear", date: "2026-11-11" })).toBe(
      "date_future",
    );
    expect(
      chequeActionProblem({ ...base, status: "cleared", action: "cancel", reason: "x y z" }),
    ).toBe("cheque_transition");
  });

  it("offers only the steps possible today", () => {
    expect(
      availableChequeActions({ status: "issued", chequeDate: "2026-11-01" }, "2026-11-10"),
    ).toEqual(["present", "clear", "bounce", "cancel"]);
    // post-dated: only cancel
    expect(
      availableChequeActions({ status: "issued", chequeDate: "2026-12-01" }, "2026-11-10"),
    ).toEqual(["cancel"]);
    expect(
      availableChequeActions({ status: "cleared", chequeDate: "2026-11-01" }, "2026-11-10"),
    ).toEqual(["bounce"]);
    expect(
      availableChequeActions({ status: "bounced", chequeDate: "2026-11-01" }, "2026-11-10"),
    ).toEqual([]);
    // six months on: stale is offered
    expect(
      availableChequeActions({ status: "received", chequeDate: "2026-01-15" }, "2026-07-16"),
    ).toContain("stale");
  });
});

describe("stale and post-dated rules", () => {
  it("adds months like Postgres, clamping to the month's end", () => {
    expect(addMonths("2026-01-15", 6)).toBe("2026-07-15");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-12-31", 2)).toBe("2027-02-28");
    expect(addMonths("2026-11-30", 1)).toBe("2026-12-30");
  });

  it("makes a cheque stale strictly after six months from its date", () => {
    expect(staleFrom("2026-01-15")).toBe("2026-07-15");
    expect(isStale("2026-01-15", "2026-07-15")).toBe(false);
    expect(isStale("2026-01-15", "2026-07-16")).toBe(true);
    expect(isStale("2026-08-31", "2027-02-28")).toBe(false);
    expect(isStale("2026-08-31", "2027-03-01")).toBe(true);
    expect(
      chequeActionProblem({
        status: "issued",
        chequeDate: "2026-01-15",
        action: "stale",
        date: "2026-07-15",
        today: "2026-07-15",
      }),
    ).toBe("cheque_not_stale");
  });

  it("knows post-dated and due cheques", () => {
    expect(isPostDated("2026-12-01", "2026-11-10")).toBe(true);
    expect(isPostDated("2026-11-10", "2026-11-10")).toBe(false);
    expect(isDue("2026-11-10", "2026-11-10")).toBe(true);
    expect(isDue("2026-11-11", "2026-11-10")).toBe(false);
  });

  it("records a patient by PIN only", () => {
    expect(isPatientPin("PIN-12345")).toBe(true);
    expect(isPatientPin("Layla Demo")).toBe(false);
    expect(isPatientPin("")).toBe(false);
    expect(isPatientPin("x".repeat(21))).toBe(false);
  });

  it("takes the next leaf of a cheque book, padded", () => {
    expect(nextLeaf({ nextNumber: 101, lastNumber: 150, width: 6 })).toBe("000101");
    expect(nextLeaf({ nextNumber: 151, lastNumber: 150, width: 6 })).toBeNull();
  });
});

describe("petty cash reconciliation", () => {
  it("compares the count with the book", () => {
    expect(pettyCashCount(500, 500)).toEqual({
      difference: 0,
      state: "balanced",
      needsExplanation: false,
    });
    expect(pettyCashCount(480.5, 500)).toEqual({
      difference: -19.5,
      state: "short",
      needsExplanation: true,
    });
    expect(pettyCashCount(510, 500)).toEqual({
      difference: 10,
      state: "over",
      needsExplanation: true,
    });
    expect(pettyCashCount(0.3, 0.1).difference).toBe(0.2);
  });

  it("tops the float back up to its amount, never below zero", () => {
    expect(topUpNeeded(1000, 380.25)).toBe(619.75);
    expect(topUpNeeded(1000, 1200)).toBe(0);
    expect(monthOf("2026-11-17")).toBe("2026-11-01");
  });
});

describe("book to bank", () => {
  it("adds back cheques issued and takes off cheques received that the bank has not seen", () => {
    expect(
      bookToBank({
        glAtStatement: 10000,
        statementBalance: 11200,
        unclearedIssued: 1500,
        unclearedReceived: 300,
      }),
    ).toEqual({ expectedBank: 11200, difference: 0, reconciled: true });
  });

  it("leaves bank items the books do not have as the difference", () => {
    const r = bookToBank({
      glAtStatement: 5000,
      statementBalance: 4975,
      unclearedIssued: 0,
      unclearedReceived: 0,
    });
    expect(r).toEqual({ expectedBank: 5000, difference: -25, reconciled: false });
  });

  it("works for an overdraft (negative balances)", () => {
    expect(
      bookToBank({
        glAtStatement: -2000,
        statementBalance: -1500,
        unclearedIssued: 500,
        unclearedReceived: 0,
      }),
    ).toEqual({ expectedBank: -1500, difference: 0, reconciled: true });
  });
});

describe("codes and messages", () => {
  it("suggests the first free code", () => {
    expect(suggestCode("1150-", ["1150-1", "1150-2"])).toBe("1150-3");
    expect(suggestCode("PC-", [])).toBe("PC-1");
  });

  it("turns database hints into sentences, never the raw message", () => {
    expect(bankingErrorMessage({ hint: "bank_not_linked" }, "x")).toBe(
      BANKING_ERRORS.bank_not_linked,
    );
    expect(bankingErrorMessage({ hint: "unbalanced" }, "x")).toBe(
      "Debits and credits must be equal.",
    );
    expect(bankingErrorMessage({ code: "42501" }, "x")).toBe(BANKING_ERRORS.banking_immutable);
    expect(bankingErrorMessage({ hint: "nothing-known" }, "fallback")).toBe("fallback");
    expect(postingMessage("waiting_ledger_start", "Saved.")).toMatch(
      /waits until the ledger starts/,
    );
    expect(postingMessage("posted", "Saved.")).toBe("Saved. Posted.");
  });
});
