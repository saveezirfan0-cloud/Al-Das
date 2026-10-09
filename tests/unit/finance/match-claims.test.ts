import { describe, expect, it } from "vitest";

import {
  matchClaims,
  type ClaimToMatch,
  type InvoiceCandidate,
  type LineCandidate,
} from "@/lib/finance/match-claims";

const line = (id: string, position: number, over: Partial<LineCandidate> = {}): LineCandidate => ({
  id,
  position,
  item_code: "T-TEST-1",
  cpt_code: "99213",
  qty: 1,
  line_net: 100,
  ...over,
});
const invoice = (over: Partial<InvoiceCandidate> = {}): InvoiceCandidate => ({
  id: "inv1",
  inv_key: "ADMC/C/90001",
  is_deleted: false,
  doctor_dha_id: "DHA-TEST-1",
  lines: [line("l1", 1)],
  ...over,
});
const claim = (id: string, over: Partial<ClaimToMatch> = {}): ClaimToMatch => ({
  id,
  claim_activity_number: `CA-${id}`,
  invoice_no: " admc/c/ 90001 ",
  cpt_code: "99213",
  initial_net: 100,
  net: 100,
  quantity: 1,
  clinician_id: "DHA-TEST-1",
  activity_start_date: "2026-03-02",
  ...over,
});

describe("matchClaims", () => {
  it("matches a single claim to a single line, normalising the invoice number", () => {
    expect(matchClaims([claim("c1")], [invoice()])[0]).toEqual({
      claim_id: "c1",
      invoice_id: "inv1",
      line_id: "l1",
      status: "matched",
      reason: "ok",
      clinician_mismatch: false,
    });
  });

  it("matches on the internal item code when the CPT code differs", () => {
    const r = matchClaims(
      [claim("c1", { cpt_code: "t-test-1" })],
      [invoice({ lines: [line("l1", 1, { cpt_code: null })] })],
    );
    expect(r[0]).toMatchObject({ status: "matched", line_id: "l1" });
  });

  it("reports each failure reason", () => {
    const r = matchClaims(
      [
        claim("none", { invoice_no: "ADMC/NOPE" }),
        claim("deleted", { invoice_no: "ADMC/DEL" }),
        claim("noline", { cpt_code: "00000" }),
        claim("amount", { initial_net: 90 }),
      ],
      [invoice(), invoice({ id: "inv2", inv_key: "ADMC/DEL", is_deleted: true })],
    );
    expect(r.map((x) => [x.claim_id, x.status, x.reason, x.invoice_id])).toEqual([
      ["none", "unmatched", "no_invoice", null],
      ["deleted", "unmatched", "invoice_deleted", "inv2"],
      ["noline", "unmatched", "no_line", "inv1"],
      ["amount", "unmatched", "amount_mismatch", "inv1"],
    ]);
  });

  it("applies the 0.01 amount tolerance inclusively", () => {
    expect(matchClaims([claim("c1", { initial_net: 100.01 })], [invoice()])[0].status).toBe(
      "matched",
    );
    expect(matchClaims([claim("c1", { initial_net: 100.02 })], [invoice()])[0].reason).toBe(
      "amount_mismatch",
    );
  });

  it("pairs duplicate lines and claims in order", () => {
    const inv = invoice({ lines: [line("l1", 1), line("l2", 2)] });
    const r = matchClaims(
      [
        claim("c2", { activity_start_date: "2026-03-03" }),
        claim("c1", { activity_start_date: "2026-03-02" }),
      ],
      [inv],
    );
    expect(Object.fromEntries(r.map((x) => [x.claim_id, x.line_id]))).toEqual({
      c1: "l1",
      c2: "l2",
    });
    expect(r.every((x) => x.status === "matched")).toBe(true);
  });

  it("uses quantity to choose between identical lines", () => {
    const inv = invoice({ lines: [line("l1", 1, { qty: 1 }), line("l2", 2, { qty: 2 })] });
    const r = matchClaims(
      [
        claim("c1", { quantity: 2, activity_start_date: "2026-03-01" }),
        claim("c2", { quantity: 1, activity_start_date: "2026-03-02" }),
      ],
      [inv],
    );
    expect(Object.fromEntries(r.map((x) => [x.claim_id, x.line_id]))).toEqual({
      c1: "l2",
      c2: "l1",
    });
  });

  it("is ambiguous, never a guess, when claims and lines differ in number", () => {
    const inv = invoice({ lines: [line("l1", 1), line("l2", 2)] });
    const r = matchClaims([claim("c1")], [inv]);
    expect(r[0]).toMatchObject({
      status: "ambiguous",
      reason: "ambiguous",
      line_id: null,
      invoice_id: "inv1",
    });
    const r2 = matchClaims([claim("c1"), claim("c2")], [invoice()]);
    expect(r2.map((x) => x.status)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("flags a quantity difference without refusing the match", () => {
    expect(matchClaims([claim("c1", { quantity: 3 })], [invoice()])[0]).toMatchObject({
      status: "matched",
      reason: "quantity_mismatch",
    });
  });

  it("flags a clinician that differs from the invoice doctor", () => {
    expect(
      matchClaims([claim("c1", { clinician_id: "dha-other" })], [invoice()])[0].clinician_mismatch,
    ).toBe(true);
    expect(
      matchClaims([claim("c1", { clinician_id: null })], [invoice()])[0].clinician_mismatch,
    ).toBe(false);
  });

  it("is deterministic regardless of input order", () => {
    const inv = invoice({ lines: [line("l2", 2), line("l1", 1)] });
    const cs = [claim("c2", { activity_start_date: "2026-03-03" }), claim("c1")];
    const a = matchClaims(cs, [inv]);
    const b = matchClaims([...cs].reverse(), [inv]);
    const norm = (x: typeof a) => Object.fromEntries(x.map((m) => [m.claim_id, m.line_id]));
    expect(norm(a)).toEqual(norm(b));
  });
});
