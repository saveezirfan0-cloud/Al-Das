/**
 * Phase 20g (G9) campaign A/B tests: picking a recipient's version at dispatch, checking variant B before it is saved,
 * and the A vs B report shaping. The assignment itself is SQL (tests/db/sf20g-ab.test.ts). Synthetic values only.
 */
import { describe, expect, it } from "vitest";

import {
  abRows,
  parseAbFunnel,
  settingsForVariant,
  variantProblem,
  type VariantSettings,
} from "@/lib/campaigns/ab";
import { skipReasonLabel } from "@/lib/campaigns/constants";

const A: VariantSettings<{ id: string }> = {
  template: { id: "tpl-a" },
  map: { "body.1": "contact.first_name" },
  fallbacks: {},
};
const B: VariantSettings<{ id: string }> = {
  template: { id: "tpl-b" },
  map: { "body.1": "text:Friend" },
  fallbacks: {},
};

describe("settingsForVariant", () => {
  it("sends A to 'a' and to ordinary campaigns (null), B to 'b'", () => {
    expect(settingsForVariant("a", A, B)).toBe(A);
    expect(settingsForVariant(null, A, B)).toBe(A);
    expect(settingsForVariant(undefined, A, null)).toBe(A);
    expect(settingsForVariant("b", A, B)).toBe(B);
  });

  it("fails closed when a 'b' recipient has no version B (never falls back to A)", () => {
    expect(settingsForVariant("b", A, null)).toBeNull();
    expect(skipReasonLabel("variant_missing")).toBe("Version B is missing");
  });
});

describe("variantProblem", () => {
  const ok = {
    a: { templateId: "t1", category: "MARKETING" },
    b: { templateId: "t2", category: "marketing" },
    aMap: { "body.1": "contact.first_name" },
    bMap: { "body.1": "contact.first_name" },
    aFallbacks: {},
    bFallbacks: {},
    splitPct: 50,
  };

  it("accepts another template of the same category", () => {
    expect(variantProblem(ok)).toBeNull();
  });

  it("accepts the same template with a different mapping or fallback", () => {
    const same = { ...ok, b: { templateId: "t1", category: "MARKETING" } };
    expect(variantProblem({ ...same, bMap: { "body.1": "text:Friend" } })).toBeNull();
    expect(variantProblem({ ...same, bFallbacks: { "body.1": "there" } })).toBeNull();
  });

  it("refuses a copy of version A (blank values do not count as a difference)", () => {
    const same = { ...ok, b: { templateId: "t1", category: "MARKETING" } };
    expect(variantProblem(same)).toMatch(/same as version A/);
    expect(variantProblem({ ...same, bFallbacks: { "body.1": "" } })).toMatch(/same as version A/);
  });

  it("refuses another category (consent is decided by A's category)", () => {
    expect(variantProblem({ ...ok, b: { templateId: "t2", category: "UTILITY" } })).toMatch(
      /same category/,
    );
  });

  it("refuses a split outside 1 to 99 or not a whole number", () => {
    for (const splitPct of [0, 100, -5, 12.5, Number.NaN])
      expect(variantProblem({ ...ok, splitPct })).toMatch(/between 1% and 99%/);
    expect(variantProblem({ ...ok, splitPct: 1 })).toBeNull();
    expect(variantProblem({ ...ok, splitPct: 99 })).toBeNull();
  });
});

describe("A vs B report", () => {
  const raw = {
    a: {
      total: 12,
      eligible: 10,
      sent: 9,
      delivered: 8,
      read: 5,
      replied: 2,
      clicked: 1,
      failed: 1,
      skipped: 2,
    },
    b: {
      total: 10,
      eligible: 10,
      sent: 10,
      delivered: 10,
      read: 7,
      replied: 4,
      clicked: 3,
      failed: 0,
    },
  };

  it("parses both sides and treats junk or a missing side as zeros", () => {
    const f = parseAbFunnel(raw);
    expect(f.a).toMatchObject({ total: 12, eligible: 10, read: 5, clicked: 1, skipped: 2 });
    expect(f.b.pending).toBe(0);
    expect(parseAbFunnel({ a: { sent: "x", read: -3 } }).a).toMatchObject({ sent: 0, read: 0 });
    expect(parseAbFunnel(null).b.total).toBe(0);
    expect(parseAbFunnel([1, 2]).a.total).toBe(0);
  });

  it("gives sent, delivered, read, replied, clicked, failed side by side as % of each eligible", () => {
    const rows = abRows(parseAbFunnel(raw));
    expect(rows.map((r) => r.key)).toEqual([
      "sent",
      "delivered",
      "read",
      "replied",
      "clicked",
      "failed",
    ]);
    expect(rows.find((r) => r.key === "read")).toEqual({
      key: "read",
      label: "Read",
      a: { count: 5, pct: 50 },
      b: { count: 7, pct: 70 },
    });
    expect(rows.find((r) => r.key === "clicked")!.b).toEqual({ count: 3, pct: 30 });
  });

  it("shows 0% when a side has nobody eligible", () => {
    const rows = abRows(parseAbFunnel({ a: raw.a }));
    expect(rows.every((r) => r.b.count === 0 && r.b.pct === 0)).toBe(true);
  });
});
