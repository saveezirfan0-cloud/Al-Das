/**
 * The insurance case catalogue (docs/47): every case in insurance-cases.synthetic.json is run through the REAL rules
 * (reconcileRemittance, claimStatus, reconcileRun, matchDeposit). The expectations are PROPOSED behaviour: the case sessions
 * with Mohammed, Vineetha and Hardik are still to be held. The test fails if a required kind is missing from the catalogue,
 * if a case has no confirmer, or if the required list itself is shortened below the kinds the plan names.
 */
import { describe, expect, it } from "vitest";

import {
  reconcileRun,
  type BankLine,
  type BankSettings,
  type RemittanceBatch,
} from "@/lib/finance/bank-recon";
import { claimStatus, settlementMonthOffset, type ClaimFacts } from "@/lib/finance/claim-status";
import {
  matchDeposit,
  type DepositSettings,
  type InsurancePayment,
} from "@/lib/finance/deposit-match";
import { reconcileRemittance, type RemitClaim } from "@/lib/finance/match-remittance";
import type { RemitLine } from "@/lib/finance/parse-remittance";

import fx from "./fixtures/insurance-cases.synthetic.json";

/** The kinds the plan of 16 Oct 2026 names. Removing one from this list, or from the catalogue, fails the test. */
const PLAN_KINDS = [
  "partial_payment",
  "resubmission_after_rejection",
  "late_remittance",
  "duplicate_amount",
  "deposit_several_references",
  "unmatched_deposit",
  "taken_back",
  "write_off",
  "fully_paid_exact",
  "paid_and_denied_explained",
  "short_paid",
];

type Step = {
  remittance?: {
    claims: RemitClaim[];
    lines: Array<Partial<RemitLine>>;
    expect: Array<Record<string, unknown>>;
  };
  claim?: {
    facts: Partial<ClaimFacts>;
    expect: { status: string; outstanding: number; overpaid: number };
  };
  monthOffset?: { serviceDate: string; paidOn: string; expect: number };
  bank?: {
    batches: RemittanceBatch[];
    lines: BankLine[];
    expect: {
      autoReady: string[];
      proposals: Array<{ item: string; candidates: string[]; ambiguous: boolean }>;
      unmatchedItems: string[];
      bankUnmatched: string[];
      problems?: string[];
    };
  };
  deposit?: {
    payments: InsurancePayment[];
    cases: Array<{ line: BankLine; expect: { status: string; candidates: string[][] } }>;
  };
};
type Case = { id: string; kind: string; title: string; confirm: string; steps: Step[] };

const DEPOSIT_SETTINGS: DepositSettings = { ...fx.settings.bank, ...fx.settings.deposit };
const cases = fx.cases as unknown as Case[];
const FULL_LINE: RemitLine = {
  remittance_ref: "",
  paid_on: null,
  payer_id: null,
  claim_activity_number: null,
  invoice_no: null,
  cpt_code: null,
  quantity: null,
  claimed_amount: null,
  paid_amount: 0,
  denied_amount: 0,
  denial_code: null,
};
const BASE_FACTS: ClaimFacts = {
  net: null,
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

describe("insurance case catalogue", () => {
  it("says it is proposed behaviour and names who confirms", () => {
    expect(fx._header.status).toMatch(/NOT YET CONFIRMED/);
    expect(Object.keys(fx._header.who).sort()).toEqual(["Hardik", "Mohammed", "Vineetha"]);
    for (const c of cases) {
      expect(c.title.length, c.id).toBeGreaterThan(10);
      expect(c.confirm, c.id).toMatch(/Mohammed|Vineetha|Hardik/);
      expect(c.steps.length, c.id).toBeGreaterThan(0);
    }
  });

  it("holds every required kind, each declared and each present", () => {
    for (const k of PLAN_KINDS) expect(fx.requiredKinds, `required list lost ${k}`).toContain(k);
    const present = new Set(cases.map((c) => c.kind));
    for (const k of fx.requiredKinds) expect(present.has(k), `no case of kind ${k}`).toBe(true);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  for (const c of cases) {
    describe(`${c.id} ${c.kind}: ${c.title}`, () => {
      c.steps.forEach((step, i) => {
        if (step.remittance) {
          const r = step.remittance;
          it(`step ${i + 1}: advice lines`, () => {
            const out = reconcileRemittance(
              r.lines.map((l) => ({ ...FULL_LINE, ...l })),
              r.claims,
              [],
              fx.settings.remit,
            );
            expect(out).toHaveLength(r.expect.length);
            out.forEach((row, j) => {
              const e = r.expect[j];
              for (const [k, v] of Object.entries(e)) {
                const got =
                  k === "flags" ? [...row.flags].sort() : (row as Record<string, unknown>)[k];
                expect(got, `${c.id} line ${j + 1} ${k}`).toEqual(
                  k === "flags" ? [...(v as string[])].sort() : v,
                );
              }
            });
          });
        }
        if (step.claim) {
          const s = step.claim;
          it(`step ${i + 1}: claim status`, () => {
            const got = claimStatus(
              { ...BASE_FACTS, ...s.facts },
              fx.settings.remit.toleranceAmount,
            );
            expect(got).toEqual(s.expect);
          });
        }
        if (step.monthOffset) {
          const m = step.monthOffset;
          it(`step ${i + 1}: settlement month offset`, () => {
            expect(settlementMonthOffset(m.serviceDate, m.paidOn)).toBe(m.expect);
          });
        }
        if (step.bank) {
          const b = step.bank;
          it(`step ${i + 1}: bank reconciliation of insurer batches`, () => {
            const res = reconcileRun({
              accountId: "acc-ins",
              receivesInsurance: true,
              period: fx.settings.period,
              rules: [],
              settings: fx.settings.bank as BankSettings,
              collections: [],
              settlements: [],
              remittances: b.batches,
              lines: b.lines,
              matchedElsewhere: new Set(),
              decisions: [],
              notes: [],
              today: fx.settings.today,
              statementEnd: fx.settings.statementEnd,
            });
            expect(res.autoReady.map((a) => a.item.key)).toEqual(b.expect.autoReady);
            expect(
              res.proposals.map((p) => ({
                item: p.item.key,
                candidates: p.candidates.map((x) => x.lineId),
                ambiguous: p.candidates.every((x) => x.ambiguous),
              })),
            ).toEqual(b.expect.proposals);
            expect(res.unmatched.map((u) => u.item.key)).toEqual(b.expect.unmatchedItems);
            expect(res.bankUnmatched.map((u) => u.line.id)).toEqual(b.expect.bankUnmatched);
            if (b.expect.problems) expect(res.problems).toEqual(b.expect.problems);
          });
        }
        if (step.deposit) {
          const d = step.deposit;
          d.cases.forEach((dc, j) => {
            it(`step ${i + 1}: deposit ${j + 1} against payments`, () => {
              const res = matchDeposit(dc.line, d.payments, DEPOSIT_SETTINGS);
              expect(res.status).toBe(dc.expect.status);
              expect(res.candidates.map((x) => x.keys)).toEqual(dc.expect.candidates);
            });
          });
        }
      });
    });
  }
});
