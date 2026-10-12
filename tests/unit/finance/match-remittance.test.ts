import { describe, expect, it } from "vitest";

import {
  priceFor,
  reconcileRemittance,
  summariseReconciliation,
  type PriceRow,
  type RemitClaim,
} from "@/lib/finance/match-remittance";
import type { RemitLine } from "@/lib/finance/parse-remittance";

import fixture from "./fixtures/phase18-remittance.synthetic.json";

const claims = fixture.claims as RemitClaim[];
const prices = fixture.prices as PriceRow[];

describe("reconcileRemittance (shared fixture)", () => {
  for (const c of fixture.lines) {
    it(c.name, () => {
      const [r] = reconcileRemittance([c.line as RemitLine], claims, prices, fixture.settings);
      expect(r.match_status).toBe(c.expect.match_status);
      expect(r.expected_amount).toBe(c.expect.expected_amount);
      expect(r.expected_basis).toBe(c.expect.expected_basis);
      expect(r.short_amount).toBe(c.expect.short_amount);
      expect([...r.flags].sort()).toEqual([...c.expect.flags].sort());
    });
  }
});

describe("price list", () => {
  it("uses the price in force on the service date, newest start first", () => {
    expect(priceFor(prices, "PAYER-A", "99214", "2026-08-15")).toBe(250);
    expect(priceFor(prices, "PAYER-A", "99214", "2026-09-03")).toBe(280);
    expect(priceFor(prices, "payer-a", " 99214 ", "2026-09-03")).toBe(280); // case and surrounding spaces are ignored
    expect(priceFor(prices, "payer-a", "99214", "2026-09-03")).toBe(280); // payer ids ignore case
    expect(priceFor(prices, "PAYER-A", "00000", "2026-09-03")).toBeNull();
    expect(priceFor(prices, null, "99214", "2026-09-03")).toBeNull();
  });
});

describe("reconciliation details", () => {
  const base: RemitLine = {
    remittance_ref: "RM-9",
    paid_on: "2026-10-01",
    payer_id: "PAYER-A",
    claim_activity_number: "CA-R-1",
    invoice_no: null,
    cpt_code: null,
    quantity: null,
    claimed_amount: 200,
    paid_amount: 180,
    denied_amount: 0,
    denial_code: null,
  };

  it("keeps the same line key when the same advice is read again (idempotence)", () => {
    const a = reconcileRemittance(
      [base, { ...base, claim_activity_number: "CA-R-2" }],
      claims,
      prices,
      fixture.settings,
    );
    const b = reconcileRemittance(
      [base, { ...base, claim_activity_number: "CA-R-2" }],
      claims,
      prices,
      fixture.settings,
    );
    expect(a.map((x) => x.line_key)).toEqual(b.map((x) => x.line_key));
    expect(new Set(a.map((x) => x.line_key)).size).toBe(2);
  });

  it("numbers identical lines so both are kept, and flags the repeat", () => {
    const rows = reconcileRemittance([base, base], claims, prices, fixture.settings);
    expect(rows[0].line_key).not.toBe(rows[1].line_key);
    expect(rows[1].flags).toContain("duplicate_in_file");
    expect(rows[0].flags).not.toContain("duplicate_in_file");
  });

  it("flags a payer or invoice that disagrees with the claim without refusing the match", () => {
    const [r] = reconcileRemittance(
      [{ ...base, payer_id: "PAYER-Z", invoice_no: "ADMC/C/99999" }],
      claims,
      prices,
      fixture.settings,
    );
    expect(r.match_status).toBe("matched");
    expect(r.flags).toEqual(expect.arrayContaining(["payer_mismatch", "invoice_mismatch"]));
  });

  it("flags a claim billed below the contract price", () => {
    const cheap = claims.map((c) => (c.id === "c1" ? { ...c, net: 100 } : c));
    const [r] = reconcileRemittance(
      [{ ...base, claimed_amount: 100, paid_amount: 100 }],
      cheap,
      prices,
      fixture.settings,
    );
    expect(r.flags).toContain("billed_below_contract");
    expect(r.expected_amount).toBe(100); // the payer owes the lesser of billed and agreed
    expect(r.short_amount).toBe(0);
  });

  it("applies BOTH tolerances: a small gap is not short, a gap above both is", () => {
    const tight = { toleranceAmount: 1, tolerancePct: 0.1 };
    const [within] = reconcileRemittance([{ ...base, paid_amount: 165 }], claims, prices, tight); // gap 15, 10% of 180 = 18
    expect(within.flags).not.toContain("short_paid");
    const [beyond] = reconcileRemittance([{ ...base, paid_amount: 150 }], claims, prices, tight); // gap 30
    expect(beyond.flags).toContain("short_paid");
    expect(beyond.short_amount).toBe(30);
  });

  it("compares in whole cents (no float drift)", () => {
    const odd = claims.map((c) => (c.id === "c1" ? { ...c, net: 0.1 + 0.2 } : c));
    const [r] = reconcileRemittance([{ ...base, claimed_amount: 0.3, paid_amount: 0.3 }], odd, [], {
      toleranceAmount: 0,
      tolerancePct: 0,
    });
    expect(r.flags).toEqual([]);
    expect(r.expected_amount).toBe(0.3);
  });

  it("summarises", () => {
    const rows = reconcileRemittance(
      fixture.lines.map((l) => l.line as RemitLine),
      claims,
      prices,
      fixture.settings,
    );
    const s = summariseReconciliation(rows);
    expect(s.lines).toBe(fixture.lines.length);
    expect(s.matched + s.unmatched + s.ambiguous).toBe(s.lines);
    expect(s.short).toBe(rows.filter((r) => r.flags.includes("short_paid")).length);
    expect(s.sumShort).toBe(80); // 40 (CA-R-2) + 40 (unmatched)
  });
});
