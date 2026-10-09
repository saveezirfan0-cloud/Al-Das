import { describe, expect, it } from "vitest";

import { diffClaims, looksFiltered } from "@/lib/finance/diff-claims";
import { parseDiligenceTable, type ClaimRow } from "@/lib/finance/parse-diligence";

import { row, table } from "./diligence-factory";

const parse = (rows: Array<Record<string, unknown>>): ClaimRow[] => {
  const r = parseDiligenceTable(table(rows));
  if (!r.ok) throw new Error("fixture invalid");
  return r.rows;
};
const num = (n: number) => row({ ClaimActivityNumber: `CA-TEST-${n}` });

describe("diffClaims", () => {
  it("splits new / changed / unchanged and lists missing-since-last-file", () => {
    const existing = new Map(
      parse([num(1), num(2), num(3)]).map((r) => [r.claim_activity_number, r]),
    );
    const incoming = parse([
      num(1), // unchanged
      row({
        ClaimActivityNumber: "CA-TEST-2",
        RemittedAmt: 100,
        RejectedAmt: 0,
        ClaimStatus: "Paid",
      }), // changed
      num(4), // new
    ]);
    const d = diffClaims(existing, incoming, ["CA-TEST-1", "CA-TEST-2", "CA-TEST-3"]);
    expect(d.newRows.map((r) => r.claim_activity_number)).toEqual(["CA-TEST-4"]);
    expect(d.unchanged.map((r) => r.claim_activity_number)).toEqual(["CA-TEST-1"]);
    expect(d.missing).toEqual(["CA-TEST-3"]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0].changes).toEqual({
      remitted: { old: 60, new: 100 },
      rejected: { old: 40, new: 0 },
      claim_status: { old: "Partially Paid", new: "Paid" },
    });
    expect(d.changedFieldCounts).toEqual({ remitted: 1, rejected: 1, claim_status: 1 });
  });

  it("treats 100 and 100.004 as equal and null/blank as equal", () => {
    const existing = new Map(
      parse([row({ NetAmt: 100, UnprocessedAmt: "" })]).map((r) => [r.claim_activity_number, r]),
    );
    const incoming = parse([row({ NetAmt: 100.004, UnprocessedAmt: null })]);
    expect(diffClaims(existing, incoming, []).changed).toHaveLength(0);
  });

  it("detects a value changing to or from blank", () => {
    const existing = new Map(
      parse([row({ PriorAuthID: "" })]).map((r) => [r.claim_activity_number, r]),
    );
    const d = diffClaims(existing, parse([row({ PriorAuthID: "PA-1" })]), []);
    expect(d.changed[0].changes).toEqual({ prior_auth_id: { old: null, new: "PA-1" } });
  });

  it("flags an export that looks filtered", () => {
    expect(looksFiltered(30, 100)).toBe(true);
    expect(looksFiltered(10, 100)).toBe(false);
    expect(looksFiltered(5, 0)).toBe(false);
  });
});
