import { parseCsv } from "@/lib/finance/parse-remittance";
import { date, num, str } from "@/lib/finance/scalars";

/**
 * Parses a pasted payer price list: one service per line, "CPT code, agreed price" with an optional third column "effective
 * from" (dd-mm-yyyy or yyyy-mm-dd). A header line is skipped. Pure; errors carry line numbers and codes, never the values.
 */

export const DEFAULT_EFFECTIVE_FROM = "2000-01-01";
export const MAX_PRICE_ROWS = 5000;

export type PriceInput = { cpt_code: string; agreed_price: number; effective_from: string };
export type PriceParse = {
  rows: PriceInput[];
  errors: Array<{ line: number; code: string }>;
  skippedHeader: boolean;
};

const CODE_RE = /^[A-Za-z0-9._-]{1,40}$/;

export function parsePriceText(text: string): PriceParse {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  const errors: PriceParse["errors"] = [];
  let skippedHeader = false;
  let start = 0;
  // a header is a first line whose second cell is not a number
  if (table[0] && table[0].length >= 2 && num(table[0][1]) === "invalid") {
    skippedHeader = true;
    start = 1;
  }
  if (table.length - start > MAX_PRICE_ROWS)
    return { rows: [], errors: [{ line: 0, code: "too_many_rows" }], skippedHeader };

  const latest = new Map<string, PriceInput>();
  for (let i = start; i < table.length; i++) {
    const line = i + 1;
    const [codeRaw, priceRaw, fromRaw] = table[i];
    const code = str(codeRaw);
    const price = num(priceRaw);
    const from = fromRaw === undefined ? null : date(fromRaw);
    if (!code || !CODE_RE.test(code)) {
      errors.push({ line, code: "invalid_code" });
      continue;
    }
    if (price === null || price === "invalid" || price < 0 || price >= 1e9) {
      errors.push({ line, code: "invalid_price" });
      continue;
    }
    if (from === "invalid") {
      errors.push({ line, code: "invalid_date" });
      continue;
    }
    const row: PriceInput = {
      cpt_code: code,
      agreed_price: Math.round(price * 100) / 100,
      effective_from: from ?? DEFAULT_EFFECTIVE_FROM,
    };
    latest.set(`${row.cpt_code.toUpperCase()}|${row.effective_from}`, row);
  }
  return { rows: [...latest.values()], errors, skippedHeader };
}
