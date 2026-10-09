import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  invalidInvoiceCount,
  uniteFinanceRequestSchema,
  uniteFinanceResponseSchema,
} from "@/lib/finance/unite-payload";

const fixture = JSON.parse(
  readFileSync(join(__dirname, "fixtures/finance-batch.synthetic.json"), "utf8"),
);

describe("Unite finance payload", () => {
  it("parses the envelope and keeps unknown fields", () => {
    const parsed = uniteFinanceResponseSchema.parse(fixture);
    expect(parsed.Data).toHaveLength(2);
    expect(parsed.DataBalancetoSync).toBe(1);
    expect(parsed.Data?.[0]).toHaveProperty("PatientName"); // passthrough: raw is never trimmed
  });

  it("accepts an empty AppointmentId (direct invoice)", () => {
    const parsed = uniteFinanceResponseSchema.parse(fixture);
    expect(parsed.Data?.[1].AppointmentId).toBe("");
  });

  it("counts invoices that fail validation without throwing", () => {
    const bad = { ...fixture, Data: [...fixture.Data, { AppointmentId: "x" }] };
    expect(invalidInvoiceCount(bad)).toBe(1);
    expect(invalidInvoiceCount(null)).toBe(0);
  });

  it("validates the request body shape", () => {
    expect(
      uniteFinanceRequestSchema.safeParse({
        fromDate: "01-01-2026",
        toDate: "09-10-2026",
        count: 50,
      }).success,
    ).toBe(true);
    expect(
      uniteFinanceRequestSchema.safeParse({
        fromDate: "2026-01-01",
        toDate: "09-10-2026",
        count: 50,
      }).success,
    ).toBe(false);
  });
});
