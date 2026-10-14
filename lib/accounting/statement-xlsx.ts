import type { StatementPdfInput } from "@/lib/accounting/sales-pdf";

/**
 * A customer statement as an .xlsx workbook (one sheet, plain values, no formulas: nothing typed into Pulse can run in a
 * spreadsheet, and the balances are Pulse's own).
 */
const MONEY = "#,##0.00;[Red](#,##0.00)";
const KIND = { invoice: "Invoice", credit_note: "Credit note", receipt: "Receipt" } as const;

export async function statementWorkbook(s: StatementPdfInput): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  wb.created = new Date(s.builtAt);
  wb.creator = "Pulse";
  const ws = wb.addWorksheet("Statement");
  ws.columns = [
    { key: "date", width: 12 },
    { key: "kind", width: 14 },
    { key: "number", width: 22 },
    { key: "reference", width: 22 },
    { key: "debit", width: 16 },
    { key: "credit", width: 16 },
    { key: "balance", width: 16 },
  ];
  ws.addRow([s.seller.name]).font = { bold: true };
  ws.addRow([`Statement of account: ${s.customer.name}${s.customer.trn ? ` (TRN ${s.customer.trn})` : ""}`]);
  ws.addRow([`${s.from} to ${s.to}, amounts in AED`]);
  ws.addRow([]);
  ws.addRow(["Date", "Type", "Number", "Reference", "Debit", "Credit", "Balance"]).font = { bold: true };
  ws.addRow([s.from, "Opening balance", "", "", null, null, s.opening]);
  for (const r of s.rows)
    ws.addRow([
      r.date,
      KIND[r.kind],
      r.number,
      r.reference ?? "",
      r.debit || null,
      r.credit || null,
      r.balance,
    ]);
  ws.addRow([s.to, "Closing balance", "", "", null, null, s.closing]).font = { bold: true };
  for (const col of [5, 6, 7]) ws.getColumn(col).numFmt = MONEY;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
