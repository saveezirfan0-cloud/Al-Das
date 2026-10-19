import { describe, expect, it } from "vitest";

import {
  CLAIM_STATUS_LABELS,
  CLAIM_STATUS_VARIANT,
  claimFactsFromRow,
  claimStatus,
  denialOutcomeOf,
  isClaimStatus,
  settlementMonthOffset,
  takenBackByClaim,
  type ClaimActivityRow,
  type ClaimFacts,
  type ClaimStatusContext,
} from "@/lib/finance/claim-status";
import { matchDeposit, type DepositSettings } from "@/lib/finance/deposit-match";
import {
  avoidableLabel,
  CATEGORY_LABELS,
  originBreakdown,
  rejectionOrigin,
  type DenialCodeRow,
} from "@/lib/finance/denials";

import proposal from "./fixtures/rejection-origin-proposal.synthetic.json";
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

describe("rejectionOrigin (data on fin_ref_denial_codes)", () => {
  const row = (
    code: string,
    over: Partial<DenialCodeRow> = {},
    isFamily = false,
  ): DenialCodeRow => ({
    code,
    isFamily,
    description: "synthetic",
    category: "other",
    defaultOwnerRole: "insurance",
    resubmitDays: 30,
    appealable: true,
    active: true,
    ...over,
  });
  const table = [
    row("AUTH-001", { category: "authorization", origin: "front_desk", avoidable: true }),
    row("MNEC", { category: "medical_necessity", origin: "clinical", avoidable: false }, true),
    row("PRCE", { category: "pricing", origin: "payer", avoidable: null }, true),
    row("NEW-1", { category: "authorization" }), // added by Finance, not classified yet
    row("ODD-1", { origin: "somewhere" as never, avoidable: "yes" as never }),
    row("OFF-1", { origin: "billing", avoidable: true, active: false }),
  ];
  it("reads the code's row through the taxonomy lookup (exact code, then family)", () => {
    expect(rejectionOrigin("AUTH-001", table)).toEqual({ origin: "front_desk", avoidable: true });
    expect(rejectionOrigin("mnec-003", table)).toEqual({ origin: "clinical", avoidable: false });
    expect(rejectionOrigin("PRCE-9", table)).toEqual({ origin: "payer", avoidable: null });
  });
  it("is the data, not the category: an unclassified row stays not classified", () => {
    expect(rejectionOrigin("NEW-1", table)).toEqual({ origin: null, avoidable: null });
  });
  it("an unknown, blank, inactive or malformed code is not classified, never 'not avoidable'", () => {
    for (const code of ["ZZZ-1", null, "", "OFF-1", "ODD-1"])
      expect(rejectionOrigin(code, table)).toEqual({ origin: null, avoidable: null });
    expect(avoidableLabel(null)).toBe("Not classified");
    expect(avoidableLabel(false)).toBe("Not avoidable");
  });
  it("the seeded proposal covers every category (the migration's table, docs/48)", () => {
    expect(Object.keys(proposal.byCategory).sort()).toEqual(Object.keys(CATEGORY_LABELS).sort());
    expect(proposal.byCategory.other).toEqual({ origin: null, avoidable: null });
  });
});

describe("originBreakdown", () => {
  const table: DenialCodeRow[] = [
    {
      code: "AUTH",
      isFamily: true,
      description: "x",
      category: "authorization",
      defaultOwnerRole: "insurance",
      resubmitDays: 30,
      appealable: true,
      active: true,
      origin: "front_desk",
      avoidable: true,
    },
    {
      code: "MNEC",
      isFamily: true,
      description: "x",
      category: "medical_necessity",
      defaultOwnerRole: "insurance",
      resubmitDays: 30,
      appealable: true,
      active: true,
      origin: "clinical",
      avoidable: false,
    },
  ];
  it("counts and sums by origin and by avoidable, with not classified kept apart", () => {
    const b = originBreakdown(
      [
        { reasonCode: "AUTH-1", amount: 10.1 },
        { reasonCode: "AUTH-2", amount: "20.2" },
        { reasonCode: "MNEC-1", amount: 5 },
        { reasonCode: "ZZZ", amount: 1 },
        { reasonCode: null, amount: null },
      ],
      table,
    );
    expect(b.byOrigin.map((r) => [r.origin, r.count, r.amount])).toEqual([
      ["front_desk", 2, 30.3],
      ["clinical", 1, 5],
      ["billing", 0, 0],
      ["payer", 0, 0],
      [null, 2, 1],
    ]);
    expect(b.avoidable).toEqual({ count: 2, amount: 30.3 });
    expect(b.notAvoidable).toEqual({ count: 1, amount: 5 });
    expect(b.notClassified).toEqual({ count: 2, amount: 1 });
    expect(b.total).toEqual({ count: 5, amount: 36.3 });
  });
  it("the parts always add up to the total, to the fils", () => {
    const cases = Array.from({ length: 30 }, (_, i) => ({
      reasonCode: ["AUTH-1", "MNEC-2", "X"][i % 3],
      amount: 0.1 * (i + 1),
    }));
    const b = originBreakdown(cases, table);
    const fils = (n: number) => Math.round(n * 100);
    expect(b.byOrigin.reduce((s, r) => s + fils(r.amount), 0)).toBe(fils(b.total.amount));
    expect(
      fils(b.avoidable.amount) + fils(b.notAvoidable.amount) + fils(b.notClassified.amount),
    ).toBe(fils(b.total.amount));
  });
  it("is empty for no cases", () => {
    expect(originBreakdown([], table).total).toEqual({ count: 0, amount: 0 });
  });
});

describe("claim status from a Diligence row", () => {
  const ROW: ClaimActivityRow = {
    net: 100,
    remitted: 0,
    rejected: 0,
    write_off: null,
    write_off_status: null,
    claim_status: null,
    resubmission_count: 0,
    last_resubmission_date: null,
    last_remittance_date: null,
  };
  const CTX: ClaimStatusContext = {
    takenBack: 0,
    denialOutcome: "none",
    bankReceived: false,
    acceptedStatuses: ["Accepted"],
    remittedNetsTakebacks: null,
  };
  const status = (row: Partial<ClaimActivityRow>, ctx: Partial<ClaimStatusContext> = {}) =>
    claimStatus(claimFactsFromRow({ ...ROW, ...row }, { ...CTX, ...ctx }), 1).status;

  it("unconfirmed or 'no': Remitted is gross and Pulse deducts the take-back", () => {
    expect(status({ remitted: 100 }, { takenBack: 100 })).toBe("taken_back");
    expect(status({ remitted: 100 }, { takenBack: 100, remittedNetsTakebacks: false })).toBe(
      "taken_back",
    );
  });
  it("'yes': Remitted already nets the take-back, so it is added back first", () => {
    // paid 100, 100 taken back: Diligence shows 0 remitted
    expect(status({ remitted: 0 }, { takenBack: 100, remittedNetsTakebacks: true })).toBe(
      "taken_back",
    );
    // paid 100, 100 taken back, paid 100 again: Diligence shows 100
    expect(status({ remitted: 100 }, { takenBack: 100, remittedNetsTakebacks: true })).toBe("paid");
    // the same figures read as gross would wrongly say taken back
    expect(status({ remitted: 100 }, { takenBack: 100, remittedNetsTakebacks: null })).toBe(
      "taken_back",
    );
  });
  it("reads numeric strings, the approved write-off and the accepted statuses (case and spaces ignored)", () => {
    expect(status({ remitted: "100.00", net: "100.00" })).toBe("paid");
    expect(status({ claim_status: "  accepted " })).toBe("under_review");
    expect(status({ claim_status: "Pending" })).toBe("submitted");
    expect(status({ remitted: 60, write_off: 40, write_off_status: "Approved" })).toBe(
      "written_off",
    );
    expect(status({ remitted: 60, write_off: 40, write_off_status: "Requested" })).toBe(
      "partly_paid",
    );
  });
  it("fails closed: an unreadable figure is unknown", () => {
    expect(status({ net: null })).toBe("unknown");
    expect(status({ remitted: "abc" })).toBe("unknown");
  });
  it("a lost denial case closes the claim", () => {
    expect(status({ rejected: 100 }, { denialOutcome: "lost" })).toBe("closed");
  });
});

describe("takenBackByClaim and denialOutcomeOf", () => {
  it("sums only negative lines with a claim, as positive amounts in fils", () => {
    const m = takenBackByClaim([
      { claim_activity_id: "a", paid_amount: -10.1 },
      { claim_activity_id: "a", paid_amount: "-0.2" },
      { claim_activity_id: "a", paid_amount: 50 },
      { claim_activity_id: null, paid_amount: -5 },
      { claim_activity_id: "b", paid_amount: null },
      { claim_activity_id: "c", paid_amount: "x" },
    ]);
    expect([...m]).toEqual([["a", 10.3]]);
  });
  it("a case being worked is open; otherwise the latest case decides", () => {
    expect(denialOutcomeOf([])).toBe("none");
    expect(
      denialOutcomeOf([
        { status: "lost", denied_on: "2026-01-01" },
        { status: "appealed", denied_on: "2025-12-01" },
      ]),
    ).toBe("open");
    expect(
      denialOutcomeOf([
        { status: "won", denied_on: "2026-01-01" },
        { status: "lost", denied_on: "2026-03-01" },
      ]),
    ).toBe("lost");
    expect(denialOutcomeOf([{ status: "written_off", denied_on: "2026-01-01" }])).toBe(
      "written_off",
    );
    expect(denialOutcomeOf([{ status: "recovered", denied_on: "2026-01-01" }])).toBe("none");
  });
  it("labels and chip colours cover every status; the filter accepts only real statuses", () => {
    for (const s of Object.keys(CLAIM_STATUS_LABELS)) {
      expect(isClaimStatus(s)).toBe(true);
      expect(CLAIM_STATUS_VARIANT[s as keyof typeof CLAIM_STATUS_VARIANT]).toBeTruthy();
    }
    expect(isClaimStatus("approved")).toBe(false);
    expect(isClaimStatus(null)).toBe(false);
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
