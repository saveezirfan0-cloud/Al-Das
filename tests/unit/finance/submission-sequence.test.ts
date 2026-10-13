/**
 * Phase 20I: the submission sequence rebuilt from the stored Diligence history (synthetic cases in followup.synthetic.json).
 */
import { describe, expect, it } from "vitest";

import {
  buildSubmissionSequence,
  ordinal,
  type SequenceClaim,
  type SequenceEvent,
} from "@/lib/finance/submission-sequence";

import fixture from "./fixtures/followup.synthetic.json";

type Case = {
  name: string;
  claim: SequenceClaim;
  events: SequenceEvent[];
  expected: {
    steps: Array<Record<string, unknown>>;
    gaps: number;
    complete: boolean;
    remittedExceedsClaimed: boolean;
  };
};

describe("submission sequence", () => {
  for (const c of fixture.sequences as unknown as Case[]) {
    it(c.name, () => {
      const seq = buildSubmissionSequence(c.claim, c.events);
      expect(seq.steps).toHaveLength(c.expected.steps.length);
      c.expected.steps.forEach((e, i) => expect(seq.steps[i], `step ${i + 1}`).toMatchObject(e));
      expect(seq.gaps).toBe(c.expected.gaps);
      expect(seq.complete).toBe(c.expected.complete);
      expect(seq.remittedExceedsClaimed).toBe(c.expected.remittedExceedsClaimed);
      expect(seq.steps.filter((s) => s.current)).toHaveLength(1);
      expect(seq.steps.map((s) => s.n)).toEqual(seq.steps.map((_, i) => i + 1));
    });
  }

  it("does not depend on the order the events are given in", () => {
    const c = (fixture.sequences as unknown as Case[])[1];
    const a = buildSubmissionSequence(c.claim, c.events);
    const b = buildSubmissionSequence(c.claim, [...c.events].reverse());
    expect(b).toEqual(a);
  });

  it("a remittance dated after the resubmission belongs to the new step", () => {
    const seq = buildSubmissionSequence(
      {
        transactionDate: "2026-01-01",
        initialNet: 300,
        initialRejected: 0,
        net: 300,
        remitted: 300,
        rejected: 0,
        resubmissionCount: 1,
        lastResubmissionDate: "2026-02-01",
        lastRemittanceDate: "2026-02-20",
      },
      [
        {
          observedAt: "2026-03-01T00:00:00Z",
          changedFields: {
            resubmission_count: { old: 0, new: 1 },
            last_resubmission_date: { old: null, new: "2026-02-01" },
            remitted: { old: 0, new: 300 },
            last_remittance_date: { old: null, new: "2026-02-20" },
          },
        },
      ],
    );
    expect(seq.steps[0]).toMatchObject({ remittedInStep: 0 });
    expect(seq.steps[1]).toMatchObject({ remittedInStep: 300, mode: "unknown" });
  });

  it("marks a net change without a resubmission as an amendment", () => {
    const seq = buildSubmissionSequence(
      {
        transactionDate: "2026-01-01",
        initialNet: 500,
        initialRejected: 0,
        net: 450,
        remitted: 0,
        rejected: 0,
        resubmissionCount: 0,
        lastResubmissionDate: null,
        lastRemittanceDate: null,
      },
      [{ observedAt: "2026-02-01T00:00:00Z", changedFields: { net: { old: 500, new: 450 } } }],
    );
    expect(seq.steps).toHaveLength(1);
    expect(seq.steps[0]).toMatchObject({ claimed: 450, amended: true, current: true });
  });

  it("a claim with no history at all is one current submission", () => {
    const seq = buildSubmissionSequence(
      {
        transactionDate: null,
        initialNet: null,
        initialRejected: null,
        net: null,
        remitted: null,
        rejected: null,
        resubmissionCount: null,
        lastResubmissionDate: null,
        lastRemittanceDate: null,
      },
      [],
    );
    expect(seq.steps).toHaveLength(1);
    expect(seq.steps[0]).toMatchObject({ n: 1, mode: "first", claimed: null, current: true });
    expect(seq.remittedExceedsClaimed).toBe(false);
  });

  it("numbers steps in English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
    ]);
  });
});
