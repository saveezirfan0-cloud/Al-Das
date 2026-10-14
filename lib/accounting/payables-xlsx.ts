import type { PayablesAgeing, SupplierStatement } from "@/lib/accounting/payables-ageing";
import { AGEING_BUCKETS } from "@/lib/accounting/sales";
import { tablesWorkbook, tableWorkbook } from "@/lib/export/table-xlsx";

/** The payables ageing (per supplier, then every open invoice) and a supplier statement as Excel (Phase G). */

export function payablesAgeingWorkbook(
  a: PayablesAgeing,
  meta: { org: string; builtAt: string },
): Promise<Buffer> {
  const names = new Map(a.rows.map((r) => [r.supplierId, r.name]));
  const note =
    a.otherCurrency > 0
      ? [`${a.otherCurrency} item(s) in a currency other than AED are left out.`]
      : [];
  return tablesWorkbook({
    ...meta,
    sheets: [
      {
        sheet: "By supplier",
        title: `Payables ageing as at ${a.asOf} (AED)`,
        lines: note,
        columns: [
          { header: "Supplier", width: 36 },
          { header: "Open invoices", kind: "number", width: 14 },
          ...AGEING_BUCKETS.map((b) => ({ header: b.label, kind: "money" as const })),
          { header: "Paid on account", kind: "money" },
          { header: "Total", kind: "money" },
        ],
        rows: a.rows.map((r) => [
          r.name,
          r.openInvoices,
          ...AGEING_BUCKETS.map((b) => r.buckets[b.key]),
          r.onAccount,
          r.total,
        ]),
        totals: [
          "Total",
          a.totals.openInvoices,
          ...AGEING_BUCKETS.map((b) => a.totals.buckets[b.key]),
          a.totals.onAccount,
          a.totals.total,
        ],
      },
      {
        sheet: "Open invoices",
        title: `Open supplier invoices as at ${a.asOf} (AED)`,
        columns: [
          { header: "Supplier", width: 36 },
          { header: "Invoice", width: 18 },
          { header: "Dated", kind: "date" },
          { header: "Due", kind: "date" },
          { header: "Days overdue", kind: "number", width: 14 },
          { header: "Age", width: 10 },
          { header: "Amount", kind: "money" },
        ],
        rows: a.open.map((o) => [
          names.get(o.supplierId) ?? "-",
          o.number,
          o.invoiceDate,
          o.dueDate,
          o.daysOverdue,
          AGEING_BUCKETS.find((b) => b.key === o.bucket)?.label ?? o.bucket,
          o.amount,
        ]),
      },
    ],
  });
}

export function supplierStatementWorkbook(
  s: SupplierStatement & { supplier: { name: string } },
  meta: { org: string; builtAt: string },
): Promise<Buffer> {
  return tableWorkbook({
    ...meta,
    sheet: "Statement",
    title: `Supplier statement: ${s.supplier.name}, ${s.from} to ${s.to} (AED)`,
    lines:
      s.otherCurrency > 0
        ? [`${s.otherCurrency} item(s) in another currency are not included.`]
        : [],
    columns: [
      { header: "Date", kind: "date" },
      { header: "Document", width: 30 },
      { header: "Billed", kind: "money" },
      { header: "Paid", kind: "money" },
      { header: "Owed", kind: "money" },
    ],
    rows: [
      [s.from, "Opening balance", null, null, s.opening],
      ...s.rows.map((r) => [
        r.date,
        `${r.kind === "invoice" ? "Invoice" : "Payment"} ${r.number}`,
        r.credit || null,
        r.debit || null,
        r.balance,
      ]),
    ],
    totals: [s.to, "Closing balance", s.billed, s.paid, s.closing],
  });
}
