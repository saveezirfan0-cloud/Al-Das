import { describe, expect, it } from "vitest";

import { lineKey, lineKeys, normalizeInvoiceNumber, paymentKey } from "@/lib/finance/keys";

describe("finance keys", () => {
  it("normalises invoice numbers for matching", () => {
    expect(normalizeInvoiceNumber(" admc/c/ 44447 ")).toBe("ADMC/C/44447");
    expect(normalizeInvoiceNumber(null)).toBe("");
  });

  it("numbers repeated item codes in delivery order", () => {
    expect(lineKeys("ADMC/1", ["A", "B", "A", "A"])).toEqual([
      "ADMC/1|A|1",
      "ADMC/1|B|1",
      "ADMC/1|A|2",
      "ADMC/1|A|3",
    ]);
  });

  it("rejects an invalid occurrence", () => {
    expect(() => lineKey("X", "A", 0)).toThrow(RangeError);
  });

  it("builds a stable payment key with blank parts", () => {
    expect(paymentKey("ADMC/1", 1, "R-9")).toBe("ADMC/1|1|R-9");
    expect(paymentKey("ADMC/1", null, undefined)).toBe("ADMC/1||");
  });
});
