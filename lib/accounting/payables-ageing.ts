import { fils } from "@/lib/accounting/posting/lines";
import { ageBucket, AGEING_BUCKETS, type AgeingBucket } from "@/lib/accounting/sales";

/**
 * Payables ageing and the supplier statement (Phase G, pure). Built over the Phase 20D sub-ledger: supplier invoices
 * (fin_supplier_invoices) and the payment vouchers that paid them (fin_payment_vouchers, status paid, with their payment
 * date). Supplier names, numbers, dates and amounts only.
 *
 * Ageing as at a date: an invoice is open when it is dated on or before that date, is not void, and no paid voucher that
 * settles it was paid by then. It is aged by its due date (else the invoice date plus the supplier's payment terms, else
 * the invoice date). A paid voucher for a supplier that names no invoice is money paid on account and is shown as a
 * negative amount, as the receivables ageing shows unallocated receipts.
 *
 * Statement: invoices raise the balance owed, payments (the vouchers' amounts on their payment date) lower it. A voucher
 * whose amount differs from the invoices it settles (within the voucher tolerance) therefore leaves the difference on the
 * statement, while the ageing counts those invoices as settled: the statement is the money, the ageing is the bills.
 *
 * Only AED is summed; items in another currency are left out and counted, so a total never mixes currencies.
 */

export type PayableInvoice = {
  id: string;
  supplierId: string;
  number: string;
  invoiceDate: string;
  dueDate: string | null;
  total: number | string;
  currency: string;
  status: string;
};

export type SupplierPayment = {
  id: string;
  supplierId: string;
  voucherNo: string;
  /** The payment date recorded on the voucher. */
  date: string | null;
  amount: number | string;
  currency: string;
  /** The supplier invoices this voucher pays (empty = paid on account). */
  invoiceIds: readonly string[];
};

export type SupplierRef = { id: string; name: string; termsDays: number | null };

export type PayablesAgeingRow = {
  supplierId: string;
  name: string;
  buckets: Record<AgeingBucket, number>;
  onAccount: number;
  total: number;
  openInvoices: number;
};

export type OpenPayable = {
  invoiceId: string;
  supplierId: string;
  number: string;
  invoiceDate: string;
  dueDate: string;
  daysOverdue: number;
  bucket: AgeingBucket;
  amount: number;
};

export type PayablesAgeing = {
  asOf: string;
  rows: PayablesAgeingRow[];
  totals: Omit<PayablesAgeingRow, "supplierId" | "name">;
  open: OpenPayable[];
  otherCurrency: number;
};

const empty = (): Record<AgeingBucket, number> => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d91_120: 0,
  d120_plus: 0,
});

const DAY = 86_400_000;
const dayNo = (d: string) => Math.floor(Date.parse(`${d}T00:00:00Z`) / DAY);
const plusDays = (d: string, n: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/** When an invoice falls due: its own due date, else the supplier's terms after the invoice date, else the invoice date. */
export function payableDueDate(
  inv: Pick<PayableInvoice, "invoiceDate" | "dueDate">,
  termsDays: number | null,
): string {
  if (inv.dueDate) return inv.dueDate;
  if (termsDays && termsDays > 0) return plusDays(inv.invoiceDate, termsDays);
  return inv.invoiceDate;
}

/** The earliest payment date of a paid voucher settling each invoice. */
export function settledOn(payments: readonly SupplierPayment[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of payments) {
    if (!p.date) continue;
    for (const id of p.invoiceIds) {
      const prev = out.get(id);
      if (!prev || p.date < prev) out.set(id, p.date);
    }
  }
  return out;
}

const isAed = (c: string) => (c || "AED").toUpperCase() === "AED";

export function buildPayablesAgeing(
  invoices: readonly PayableInvoice[],
  payments: readonly SupplierPayment[],
  suppliers: readonly SupplierRef[],
  asOf: string,
): PayablesAgeing {
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const settled = settledOn(payments);
  const rows = new Map<string, { b: Record<AgeingBucket, number>; onAccount: number; n: number }>();
  const row = (id: string) => {
    const r = rows.get(id) ?? { b: empty(), onAccount: 0, n: 0 };
    rows.set(id, r);
    return r;
  };
  const open: OpenPayable[] = [];
  let otherCurrency = 0;
  for (const inv of invoices) {
    if (inv.status === "void" || inv.invoiceDate > asOf) continue;
    const paidOn = settled.get(inv.id);
    if (paidOn ? paidOn <= asOf : inv.status === "paid") continue;
    if (!isAed(inv.currency)) {
      otherCurrency++;
      continue;
    }
    const due = payableDueDate(inv, byId.get(inv.supplierId)?.termsDays ?? null);
    const bucket = ageBucket(asOf, due);
    const f = fils(inv.total);
    const r = row(inv.supplierId);
    r.b[bucket] += f;
    r.n++;
    open.push({
      invoiceId: inv.id,
      supplierId: inv.supplierId,
      number: inv.number,
      invoiceDate: inv.invoiceDate,
      dueDate: due,
      daysOverdue: Math.max(0, dayNo(asOf) - dayNo(due)),
      bucket,
      amount: f / 100,
    });
  }
  for (const p of payments) {
    if (p.invoiceIds.length > 0 || !p.date || p.date > asOf) continue;
    if (!isAed(p.currency)) {
      otherCurrency++;
      continue;
    }
    row(p.supplierId).onAccount -= fils(p.amount);
  }
  const tot = { b: empty(), onAccount: 0, n: 0 };
  const out: PayablesAgeingRow[] = [];
  for (const [supplierId, r] of rows) {
    let total = r.onAccount;
    const buckets = empty();
    for (const { key } of AGEING_BUCKETS) {
      buckets[key] = r.b[key] / 100;
      total += r.b[key];
      tot.b[key] += r.b[key];
    }
    tot.onAccount += r.onAccount;
    tot.n += r.n;
    if (total === 0 && r.onAccount === 0) continue;
    out.push({
      supplierId,
      name: byId.get(supplierId)?.name ?? "-",
      buckets,
      onAccount: r.onAccount / 100,
      total: total / 100,
      openInvoices: r.n,
    });
  }
  const totalsBuckets = empty();
  let grand = tot.onAccount;
  for (const { key } of AGEING_BUCKETS) {
    totalsBuckets[key] = tot.b[key] / 100;
    grand += tot.b[key];
  }
  return {
    asOf,
    rows: out.sort(
      (a, b) => a.name.localeCompare(b.name) || a.supplierId.localeCompare(b.supplierId),
    ),
    totals: {
      buckets: totalsBuckets,
      onAccount: tot.onAccount / 100,
      total: grand / 100,
      openInvoices: tot.n,
    },
    open: open.sort((a, b) => b.daysOverdue - a.daysOverdue || a.number.localeCompare(b.number)),
    otherCurrency,
  };
}

export type SupplierStatementRow = {
  date: string;
  kind: "invoice" | "payment";
  number: string;
  /** What the supplier billed (raises the balance owed). */
  credit: number;
  /** What was paid (lowers it). */
  debit: number;
  balance: number;
};

export type SupplierStatement = {
  from: string;
  to: string;
  opening: number;
  rows: SupplierStatementRow[];
  billed: number;
  paid: number;
  closing: number;
  otherCurrency: number;
};

/** One supplier's statement: opening balance owed, each invoice and payment with the running balance, closing balance. */
export function buildSupplierStatement(
  invoices: readonly PayableInvoice[],
  payments: readonly SupplierPayment[],
  from: string,
  to: string,
): SupplierStatement {
  let opening = 0;
  let otherCurrency = 0;
  const entries: Array<{ date: string; kind: "invoice" | "payment"; number: string; f: number }> =
    [];
  for (const inv of invoices) {
    if (inv.status === "void" || inv.invoiceDate > to) continue;
    if (!isAed(inv.currency)) {
      otherCurrency++;
      continue;
    }
    if (inv.invoiceDate < from) opening += fils(inv.total);
    else
      entries.push({
        date: inv.invoiceDate,
        kind: "invoice",
        number: inv.number,
        f: fils(inv.total),
      });
  }
  for (const p of payments) {
    if (!p.date || p.date > to) continue;
    if (!isAed(p.currency)) {
      otherCurrency++;
      continue;
    }
    if (p.date < from) opening -= fils(p.amount);
    else entries.push({ date: p.date, kind: "payment", number: p.voucherNo, f: fils(p.amount) });
  }
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.kind === b.kind ? 0 : a.kind === "invoice" ? -1 : 1) ||
      a.number.localeCompare(b.number),
  );
  let bal = opening;
  let billed = 0;
  let paid = 0;
  const rows = entries.map((e) => {
    if (e.kind === "invoice") {
      bal += e.f;
      billed += e.f;
    } else {
      bal -= e.f;
      paid += e.f;
    }
    return {
      date: e.date,
      kind: e.kind,
      number: e.number,
      credit: e.kind === "invoice" ? e.f / 100 : 0,
      debit: e.kind === "payment" ? e.f / 100 : 0,
      balance: bal / 100,
    };
  });
  return {
    from,
    to,
    opening: opening / 100,
    rows,
    billed: billed / 100,
    paid: paid / 100,
    closing: bal / 100,
    otherCurrency,
  };
}
