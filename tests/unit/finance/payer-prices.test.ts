import { describe, expect, it } from "vitest";

import { DEFAULT_EFFECTIVE_FROM, MAX_PRICE_ROWS, parsePriceText } from "@/lib/finance/payer-prices";

describe("parsePriceText", () => {
  it("reads code, price and an optional effective date, and skips a header", () => {
    const r = parsePriceText('CPT,Price,From\n99213,180,01-09-2026\n99214,"1,250.50"\n80053,45');
    expect(r.skippedHeader).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { cpt_code: "99213", agreed_price: 180, effective_from: "2026-09-01" },
      { cpt_code: "99214", agreed_price: 1250.5, effective_from: DEFAULT_EFFECTIVE_FROM },
      { cpt_code: "80053", agreed_price: 45, effective_from: DEFAULT_EFFECTIVE_FROM },
    ]);
  });

  it("handles a semicolon-separated file and quoted thousands", () => {
    const r = parsePriceText('99214;"1,250.50"\n80053;45');
    expect(r.rows.map((x) => [x.cpt_code, x.agreed_price])).toEqual([
      ["99214", 1250.5],
      ["80053", 45],
    ]);
  });

  it("the last line wins for the same code and date", () => {
    const r = parsePriceText("99213,100\n99213,120\n99213,130,2026-10-01");
    expect(r.rows).toHaveLength(2);
    expect(r.rows.find((x) => x.effective_from === DEFAULT_EFFECTIVE_FROM)?.agreed_price).toBe(120);
  });

  it("reports bad lines by number and code, never by value", () => {
    const r = parsePriceText(
      "99213,100\n,50\n99214,abc\n99215,-1\n99216,10,31-31-2026\nBAD CODE!,10",
    );
    expect(r.errors).toEqual([
      { line: 2, code: "invalid_code" },
      { line: 3, code: "invalid_price" },
      { line: 4, code: "invalid_price" },
      { line: 5, code: "invalid_date" },
      { line: 6, code: "invalid_code" },
    ]);
    expect(r.rows).toHaveLength(1);
    expect(JSON.stringify(r.errors)).not.toMatch(/abc|BAD/);
  });

  it("refuses an oversized paste", () => {
    const big = Array.from({ length: MAX_PRICE_ROWS + 1 }, (_, i) => `C${i},1`).join("\n");
    expect(parsePriceText(big).errors[0].code).toBe("too_many_rows");
  });
});
