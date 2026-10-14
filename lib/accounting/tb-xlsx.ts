import type { TrialBalance } from "@/lib/accounting/reports";

/**
 * The trial balance as an .xlsx workbook (one sheet). Every cell is a plain value (no formulas), so nothing typed into
 * Pulse can run in a spreadsheet, and the totals are Pulse's own. Groups are indented and bold; balances are signed
 * (debit positive, credit negative) with a Dr / Cr column for people.
 */
export type TrialBalanceWorkbookInput = {
  org: string;
  entity: string | null;
  from: string;
  to: string;
  tb: TrialBalance;
  builtAt: string;
};

const MONEY = "#,##0.00;[Red](#,##0.00)";

export async function trialBalanceWorkbook(input: TrialBalanceWorkbookInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(input.builtAt);
  wb.creator = "Pulse";
  const ws = wb.addWorksheet("Trial balance");
  ws.columns = [
    { key: "code", width: 12 },
    { key: "name", width: 44 },
    { key: "opening", width: 16 },
    { key: "debit", width: 16 },
    { key: "credit", width: 16 },
    { key: "closing", width: 16 },
    { key: "side", width: 6 },
  ];
  ws.addRow([`${input.org}${input.entity ? ` - ${input.entity}` : ""}`]).font = { bold: true };
  ws.addRow([`Trial balance ${input.from} to ${input.to}`]);
  ws.addRow([`Built ${input.builtAt.slice(0, 16).replace("T", " ")} UTC`]);
  ws.addRow([]);
  const head = ws.addRow(["Code", "Account", "Opening", "Debit", "Credit", "Closing", ""]);
  head.font = { bold: true };
  for (const l of input.tb.lines) {
    const row = ws.addRow([
      l.code,
      `${"  ".repeat(l.depth)}${l.name}`,
      l.opening,
      l.debit,
      l.credit,
      l.closing,
      l.closing > 0 ? "Dr" : l.closing < 0 ? "Cr" : "",
    ]);
    if (l.isGroup) row.font = { bold: true };
  }
  if (input.tb.earlierYearsPl !== 0)
    ws.addRow([
      "",
      "Profit or loss of earlier years (not yet closed)",
      input.tb.earlierYearsPl,
      0,
      0,
      input.tb.earlierYearsPl,
      "",
    ]);
  const t = input.tb.totals;
  const total = ws.addRow(["", "Total", t.opening, t.debit, t.credit, t.closing, ""]);
  total.font = { bold: true };
  for (const col of [3, 4, 5, 6]) ws.getColumn(col).numFmt = MONEY;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
