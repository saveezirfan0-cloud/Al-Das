import { readAmount } from "@/lib/finance/parse-import";

/**
 * Tally's trial balance exported to Excel or CSV, as rows of ledger name, debit and credit (pure). The layout is the
 * simple one Tally writes (Particulars, then Debit and Credit, sometimes under a "Closing Balance" heading on the row
 * above): the header row is the first row with a cell saying Debit and a cell saying Credit; the name column is the cell
 * saying Particulars / Ledger / Account / Name on that row or the one above, else the first column. Total rows and blank
 * rows are skipped. Amounts are read like the finance import engine reads them (readAmount).
 */

export type TbFileRow = { name: string; debit: number; credit: number };
export type TbFileResult =
  | { ok: true; rows: TbFileRow[]; skipped: number }
  | { ok: false; error: "no_header" | "bad_amount" | "duplicate_name" | "empty"; detail?: string };

export const MAX_TB_ROWS = 20_000;

const cell = (v: unknown) =>
  v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v).trim();

export function parseTrialBalanceTable(table: readonly (readonly unknown[])[]): TbFileResult {
  let header = -1;
  let dCol = -1;
  let cCol = -1;
  for (let r = 0; r < Math.min(table.length, 40) && header < 0; r++) {
    const row = table[r].map(cell);
    const d = row.findIndex((x) => /^debit\b|\bdebit$|^dr\.?$/i.test(x));
    const c = row.findIndex((x) => /^credit\b|\bcredit$|^cr\.?$/i.test(x));
    if (d >= 0 && c >= 0 && d !== c) {
      header = r;
      dCol = d;
      cCol = c;
    }
  }
  if (header < 0) return { ok: false, error: "no_header" };
  const nameRe = /^(particulars|ledger( name)?|account( name)?|name)$/i;
  let nCol = table[header].map(cell).findIndex((x) => nameRe.test(x));
  if (nCol < 0 && header > 0) nCol = table[header - 1].map(cell).findIndex((x) => nameRe.test(x));
  if (nCol < 0) nCol = 0;

  const rows: TbFileRow[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (let r = header + 1; r < table.length && rows.length <= MAX_TB_ROWS; r++) {
    const name = cell(table[r][nCol]).replace(/\s+/g, " ");
    if (!name || /^(grand )?total\b/i.test(name)) {
      skipped++;
      continue;
    }
    const d = readAmount(table[r][dCol]);
    const c = readAmount(table[r][cCol]);
    if (d === "invalid" || c === "invalid")
      return { ok: false, error: "bad_amount", detail: name.slice(0, 80) };
    const debit = Math.abs(d ?? 0);
    const credit = Math.abs(c ?? 0);
    const precise = (x: number) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
    if (!precise(debit) || !precise(credit))
      return { ok: false, error: "bad_amount", detail: name.slice(0, 80) };
    if (debit === 0 && credit === 0) {
      skipped++;
      continue;
    }
    const k = name.toLowerCase();
    if (seen.has(k)) return { ok: false, error: "duplicate_name", detail: name.slice(0, 80) };
    seen.add(k);
    rows.push({
      name: name.slice(0, 120),
      debit: Math.round(debit * 100) / 100,
      credit: Math.round(credit * 100) / 100,
    });
  }
  if (rows.length === 0) return { ok: false, error: "empty" };
  return { ok: true, rows, skipped };
}
