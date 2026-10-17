import { describe, expect, it } from "vitest";

import { claimStatus, settlementMonthOffset, type ClaimFacts } from "@/lib/finance/claim-status";
import { matchDeposit, type DepositSettings } from "@/lib/finance/deposit-match";
import {
  REJECTION_ORIGIN,
  rejectionOrigin,
  CATEGORY_LABELS,
  type DenialCodeRow,
} from "@/lib/finance/denials";
import { reconcileRemittance, type RemitClaim } from "@/lib/finance/match-remittance";

const F: ClaimFacts = {
  net: 100,
  remitted: null,
  rejected: null,
  writeOff: null,
  writeOffApproved: false,
  takenBack: null,
  resubmissionCount: null,
  lastResubmissionDate: null,
  lastRemittanceDate: null,
  accepted: false,
  bankReceived: false,
  denialOutcome: "none",
};
const st = (o: Partial<ClaimFacts>, tol = 1) => claimStatus({ ...F, ...o }, tol).status;

describe("claimStatus", () => {
  it("submitted until the payer accepts it, then under review", () => {
    expect(st({})).toBe("submitted");
    expect(st({ accepted: true })).toBe("under_review");
  });
  it("rejected only when nothing is paid", () => {
    expect(st({ rejected: 100 })).toBe("rejected");
    expect(st({ rejected: 40, remitted: 60 })).toBe("partly_paid");
  });
  it("a payment within the tolerance of the net is paid; a bank receipt closes it", () => {
    expect(st({ remitted: 99.5 })).toBe("paid");
    expect(st({ remitted: 100, bankReceived: true })).toBe("closed");
  });
  it("a denial case that was lost closes the claim; written off in the case writes it off", () => {
    expect(st({ rejected: 100, denialOutcome: "lost" })).toBe("closed");
    expect(st({ rejected: 100, denialOutcome: "written_off" })).toBe("written_off");
    expect(st({ rejected: 100, denialOutcome: "open" })).toBe("rejected");
  });
  it("an advice after the resubmission ends the waiting", () => {
    const base = { rejected: 100, resubmissionCount: 1, lastResubmissionDate: "2026-10-20" };
    expect(st({ ...base, lastRemittanceDate: "2026-10-05" })).toBe("resubmitted");
    expect(st({ ...base, lastRemittanceDate: "2026-11-05" })).toBe("rejected");
  });
  it("unknown or unusable figures give unknown, never a guess", () => {
    expect(st({ net: null })).toBe("unknown");
    expect(st({ net: 0 })).toBe("unknown");
    expect(st({ remitted: Number.NaN })).toBe("unknown");
    expect(st({}, -1)).toBe("unknown");
  });
  it("a take-back that is paid again is paid", () => {
    expect(st({ remitted: 200, takenBack: 100, net: 100 })).toBe("paid");
  });
  it("reports what is still owed and any overpayment", () => {
    expect(claimStatus({ ...F, remitted: 30 }, 1)).toMatchObject({ outstanding: 70, overpaid: 0 });
    expect(claimStatus({ ...F, remitted: 150 }, 1)).toMatchObject({ outstanding: 0, overpaid: 50 });
    expect(claimStatus({ ...F, remitted: 100.5 }, 1).overpaid).toBe(0);
  });
});

describe("settlementMonthOffset", () => {
  it("counts calendar months, across a year end, and is null without both dates", () => {
    expect(settlementMonthOffset("2026-09-30", "2026-10-01")).toBe(1);
    expect(settlementMonthOffset("2026-11-15", "2027-01-02")).toBe(2);
    expect(settlementMonthOffset(null, "2026-10-01")).toBeNull();
    expect(settlementMonthOffset("2026-10-01", "bad")).toBeNull();
  });
});

describe("matchDeposit", () => {
  const S: DepositSettings = {
    weekendDays: [],
    windowDays: 3,
    toleranceAmount: 1,
    tolerancePct: 0,
    autoAcceptScore: 80,
    cutoffDay: 30,
    maxParts: 3,
    maxPool: 4,
  };
  const pay = (
    key: string,
    amount: number,
    payerId = "A",
    date = "2026-10-10",
    ref: string | null = null,
  ) => ({
    key,
    ref,
    payerId,
    date,
    amount,
  });
  const dep = (amount: number, reference: string | null = null) => ({
    id: "L",
    valueDate: "2026-10-11",
    amount,
    reference,
    description: null,
  });

  it("never matches a debit or an empty list", () => {
    expect(matchDeposit(dep(-5), [pay("p", 5)], S).status).toBe("unmatched");
    expect(matchDeposit(dep(5), [], S).status).toBe("unmatched");
  });
  it("one fitting payment is a match; outside the date window it is not", () => {
    expect(matchDeposit(dep(100), [pay("p", 100)], S).status).toBe("matched");
    expect(matchDeposit(dep(100), [pay("p", 100, "A", "2026-10-01")], S).status).toBe("unmatched");
  });
  it("a single payment and a group that both fit are ambiguous", () => {
    const r = matchDeposit(dep(100), [pay("a", 100), pay("b", 60), pay("c", 40)], S);
    expect(r.status).toBe("ambiguous");
    expect(r.candidates.map((c) => c.keys)).toEqual([["a"], ["b", "c"]]);
  });
  it("groups never mix payers", () => {
    expect(matchDeposit(dep(100), [pay("b", 60, "A"), pay("c", 40, "B")], S).status).toBe(
      "unmatched",
    );
  });
  it("does not search groups in a pool larger than maxPool, and says so", () => {
    const pool = ["a", "b", "c", "d", "e"].map((k, i) => pay(k, 10 + i));
    const r = matchDeposit(dep(21), pool, S); // 10 + 11 would fit
    expect(r.status).toBe("unmatched");
    expect(r.poolTooLarge).toBe(true);
  });
  it("is deterministic whatever the input order", () => {
    const ps = [pay("b", 100), pay("a", 100)];
    expect(matchDeposit(dep(100), ps, S)).toEqual(matchDeposit(dep(100), [...ps].reverse(), S));
  });
});

describe("rejectionOrigin", () => {
  const row = (
    code: string,
    category: DenialCodeRow["category"],
    isFamily = false,
  ): DenialCodeRow => ({
    code,
    isFamily,
    description: "synthetic",
    category,
    defaultOwnerRole: "insurance",
    resubmitDays: 30,
    appealable: true,
    active: true,
  });
  const table = [row("AUTH-001", "authorization"), row("MNEC", "medical_necessity", true)];
  it("uses the taxonomy lookup (exact code, then family)", () => {
    expect(rejectionOrigin("AUTH-001", table)).toEqual({ origin: "front_desk", avoidable: true });
    expect(rejectionOrigin("MNEC-003", table)).toEqual({ origin: "clinical", avoidable: false });
  });
  it("an unknown or blank code is unknown, never avoidable", () => {
    expect(rejectionOrigin("ZZZ-1", table)).toEqual({ origin: "unknown", avoidable: null });
    expect(rejectionOrigin(null, table)).toEqual({ origin: "unknown", avoidable: null });
  });
  it("covers every category", () => {
    expect(Object.keys(REJECTION_ORIGIN).sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
  });
});

describe("remittance: taken back and earlier payments", () => {
  const claim: RemitClaim = {
    id: "c",
    claim_activity_number: "CA-X",
    invoice_no: "I/1",
    cpt_code: "99213",
    payer_id: "A",
    quantity: 1,
    net: 200,
    transaction_date: "2026-09-01",
    activity_start_date: "2026-09-01",
  };
  const line = (paid: number) => ({
    remittance_ref: "R",
    paid_on: "2026-10-01",
    payer_id: "A",
    claim_activity_number: "CA-X",
    invoice_no: null,
    cpt_code: null,
    quantity: null,
    claimed_amount: 200,
    paid_amount: paid,
    denied_amount: 0,
    denial_code: null,
  });
  const s = { toleranceAmount: 1, tolerancePct: 0.01 };
  it("a negative line is taken_back, never short", () => {
    const [r] = reconcileRemittance([line(-50)], [claim], [], s);
    expect(r.flags).toEqual(["taken_back"]);
    expect(r.short_amount).toBe(0);
  });
  it("without paid_before the behaviour is unchanged", () => {
    expect(reconcileRemittance([line(150)], [claim], [], s)[0].flags).toEqual(["short_paid"]);
    expect(
      reconcileRemittance([line(50)], [{ ...claim, paid_before: 150 }], [], s)[0].flags,
    ).toEqual([]);
  });
});
