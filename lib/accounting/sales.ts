/**
 * Receivables (Phase 22E), pure rules: sales invoice and credit note totals with UAE VAT, the full or simplified tax
 * invoice rule, the 14-day credit note warning, due dates, receipt allocation oldest first, ageing buckets and the
 * running balance of a customer statement. The database (migration 20261109000200) re-computes every total with the
 * same formulas and refuses a mismatch; tests/unit/accounting/sales.test.ts and tests/db/accounting-receivables.test.ts
 * keep the two in step.
 *
 * Rounding (decision, FTA-compatible): VAT is worked out PER LINE on the line's net amount and rounded to 2 decimals
 * (fils), half away from zero; the invoice VAT is the sum of the line VAT. Amounts are handled in integer fils so sums
 * never drift. Quantities have at most 3 decimals, prices and discounts at most 2.
 */

export const CUSTOMER_KINDS = ["insurer", "corporate", "tenant", "other"] as const;
export type CustomerKind = (typeof CUSTOMER_KINDS)[number];
export const CUSTOMER_KIND_LABELS: Record<CustomerKind, string> = {
  insurer: "Insurer",
  corporate: "Corporate",
  tenant: "Tenant",
  other: "Other",
};

export const SALES_STATUSES = ["draft", "issued", "part_paid", "paid", "void"] as const;
export type SalesStatus = (typeof SALES_STATUSES)[number];
export const SALES_STATUS_LABELS: Record<SalesStatus, string> = {
  draft: "Draft",
  issued: "Issued",
  part_paid: "Part paid",
  paid: "Paid",
  void: "Void",
};

export type SalesDocKind = "invoice" | "credit_note";

export const POSTING_STATUS_LABELS: Record<string, string> = {
  not_posted: "Not posted",
  posted: "Posted",
  waiting_ledger_start: "Waiting for the ledger start (kept in Tally)",
};

export const RECEIPT_MODES = ["bank_transfer", "cheque", "card", "cash", "other"] as const;
export type ReceiptMode = (typeof RECEIPT_MODES)[number];
export const RECEIPT_MODE_LABELS: Record<ReceiptMode, string> = {
  bank_transfer: "Bank transfer",
  cheque: "Cheque",
  card: "Card",
  cash: "Cash",
  other: "Other",
};

/** Tax code kinds a sale may carry (reverse charge and blocked VAT are purchase-side). */
export const SALES_TAX_KINDS = ["standard", "zero", "exempt", "out_of_scope"] as const;

export const MAX_SALES_LINES = 200;
/** FTA: a simplified tax invoice is allowed up to AED 10,000 (Executive Regulation Art. 59(6)). */
export const SIMPLIFIED_LIMIT = 10_000;
/** FTA: a tax credit note is issued within 14 days of the event (2022 amendment of Art. 62). */
export const CREDIT_NOTE_DAYS = 14;

export type SalesLineInput = {
  quantity: number;
  unitPrice: number;
  discount: number;
  /** VAT rate in percent from the line's tax code (5 for standard, 0 otherwise). */
  vatRate: number;
};

export type SalesLineAmounts = {
  gross: number;
  discount: number;
  net: number;
  vat: number;
  total: number;
};

export type SalesTotals = {
  subtotal: number;
  discount: number;
  net: number;
  vat: number;
  total: number;
  /** VAT summary per rate (for the tax invoice): net and VAT per rate, highest rate first. */
  byRate: Array<{ rate: number; net: number; vat: number }>;
};

const decimals = (n: number, max: number) =>
  Number.isFinite(n) && Math.abs(Math.round(n * 10 ** max) - n * 10 ** max) < 1e-6;

/** Integer thousandths / hundredths, exact for inputs that respect the decimal limits. */
const milli = (n: number) => Math.round(n * 1000);
const fils = (n: number) => Math.round(n * 100);
const basisPoints = (n: number) => Math.round(n * 100);

/** a / d rounded half up, for a >= 0 and d > 0 (both integers): the same as Postgres round() on a positive numeric. */
const divRound = (a: number, d: number) => Math.floor((a + d / 2) / d);

export type LineProblem =
  | "quantity"
  | "unit_price"
  | "discount"
  | "discount_above_gross"
  | "rate";

/** What is wrong with a line's numbers, or null. */
export function lineProblem(l: SalesLineInput): LineProblem | null {
  if (!(l.quantity > 0) || !decimals(l.quantity, 3) || l.quantity >= 1e9) return "quantity";
  if (!(l.unitPrice >= 0) || !decimals(l.unitPrice, 2) || l.unitPrice >= 1e12) return "unit_price";
  if (!(l.discount >= 0) || !decimals(l.discount, 2)) return "discount";
  if (!(l.vatRate >= 0 && l.vatRate <= 100) || !decimals(l.vatRate, 2)) return "rate";
  if (fils(l.discount) > lineGrossFils(l)) return "discount_above_gross";
  return null;
}

function lineGrossFils(l: SalesLineInput): number {
  // quantity (thousandths) x price (fils) / 1000, rounded half up to the fil
  return divRound(milli(l.quantity) * fils(l.unitPrice), 1000);
}

/** One line: gross = qty x price (2 dp), net = gross - discount, VAT = net x rate (2 dp, per line), total = net + VAT. */
export function lineAmounts(l: SalesLineInput): SalesLineAmounts {
  const gross = lineGrossFils(l);
  const discount = fils(l.discount);
  const net = gross - discount;
  const vat = divRound(Math.max(net, 0) * basisPoints(l.vatRate), 10_000);
  return {
    gross: gross / 100,
    discount: discount / 100,
    net: net / 100,
    vat: vat / 100,
    total: (net + vat) / 100,
  };
}

/** Invoice totals: the sum of the per-line amounts (never VAT on the invoice total). */
export function invoiceTotals(lines: readonly SalesLineInput[]): SalesTotals {
  let subtotal = 0;
  let discount = 0;
  let net = 0;
  let vat = 0;
  const byRate = new Map<number, { net: number; vat: number }>();
  for (const l of lines) {
    const a = lineAmounts(l);
    subtotal += fils(a.gross);
    discount += fils(a.discount);
    net += fils(a.net);
    vat += fils(a.vat);
    const r = byRate.get(l.vatRate) ?? { net: 0, vat: 0 };
    r.net += fils(a.net);
    r.vat += fils(a.vat);
    byRate.set(l.vatRate, r);
  }
  return {
    subtotal: subtotal / 100,
    discount: discount / 100,
    net: net / 100,
    vat: vat / 100,
    total: (net + vat) / 100,
    byRate: [...byRate.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([rate, v]) => ({ rate, net: v.net / 100, vat: v.vat / 100 })),
  };
}

/**
 * Which tax invoice to issue. Pulse issues a SIMPLIFIED tax invoice only when the customer has no TRN (not registered)
 * and the total is AED 10,000 or less; every other invoice is a FULL tax invoice. (The FTA also allows a simplified
 * invoice to a registered recipient up to AED 10,000; Pulse does not use that, because a full invoice is always valid
 * and a registered business needs one to recover its input VAT.)
 */
export function invoiceForm(
  customerTrn: string | null | undefined,
  total: number,
  limit = SIMPLIFIED_LIMIT,
): "full" | "simplified" {
  const registered = !!customerTrn && customerTrn.trim() !== "";
  return !registered && fils(total) <= fils(limit) ? "simplified" : "full";
}

const DAY = 86_400_000;
const dayNo = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);

/** Days from a to b (b - a), for yyyy-mm-dd dates. */
export function daysBetween(a: string, b: string): number {
  return dayNo(b) - dayNo(a);
}

/** The invoice date plus the customer's credit terms. */
export function dueDateFor(invoiceDate: string, termsDays: number): string {
  return isoOf(dayNo(invoiceDate) + Math.max(0, Math.trunc(termsDays)));
}

/** A credit note issued more than 14 days after its event is late under the FTA rule: warn (it is still issued). */
export function creditNoteLate(
  eventDate: string | null | undefined,
  issueDate: string,
  days = CREDIT_NOTE_DAYS,
): boolean {
  if (!eventDate) return false;
  return daysBetween(eventDate, issueDate) > days;
}

export type OpenInvoice = { id: string; invoiceDate: string; number: string | null; open: number };

/**
 * Spread a receipt over open invoices, oldest invoice first (by date, then number). What is left over stays
 * unallocated: an advance on account. Never allocates more than an invoice's open amount.
 */
export function allocateOldestFirst(
  amount: number,
  invoices: readonly OpenInvoice[],
): { allocations: Array<{ invoiceId: string; amount: number }>; unallocated: number } {
  let left = Math.max(0, fils(amount));
  const sorted = [...invoices]
    .filter((i) => fils(i.open) > 0)
    .sort(
      (a, b) =>
        a.invoiceDate.localeCompare(b.invoiceDate) || (a.number ?? "").localeCompare(b.number ?? ""),
    );
  const allocations: Array<{ invoiceId: string; amount: number }> = [];
  for (const inv of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, fils(inv.open));
    allocations.push({ invoiceId: inv.id, amount: take / 100 });
    left -= take;
  }
  return { allocations, unallocated: left / 100 };
}

/** Ageing buckets by days past the due date. */
export const AGEING_BUCKETS = [
  { key: "current", label: "Current" },
  { key: "d1_30", label: "1-30" },
  { key: "d31_60", label: "31-60" },
  { key: "d61_90", label: "61-90" },
  { key: "d91_120", label: "91-120" },
  { key: "d120_plus", label: "120+" },
] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number]["key"];

/** Not yet due (or due today) is current; then 1-30, 31-60, 61-90, 91-120 and over 120 days past due. */
export function ageBucket(asOf: string, dueDate: string): AgeingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return "current";
  if (overdue <= 30) return "d1_30";
  if (overdue <= 60) return "d31_60";
  if (overdue <= 90) return "d61_90";
  if (overdue <= 120) return "d91_120";
  return "d120_plus";
}

export type OpenItem = {
  customerId: string;
  kind: "invoice" | "on_account";
  dueDate: string | null;
  open: number;
};

export type AgeingRow = {
  customerId: string;
  buckets: Record<AgeingBucket, number>;
  /** Unallocated receipts (shown as a negative amount: money received ahead of invoices). */
  onAccount: number;
  total: number;
};

const emptyBuckets = (): Record<AgeingBucket, number> => ({
  current: 0,
  d1_30: 0,
  d31_60: 0,
  d61_90: 0,
  d91_120: 0,
  d120_plus: 0,
});

/** Receivables ageing per customer, as at a date. Totals are summed in fils. */
export function buildAgeing(
  items: readonly OpenItem[],
  asOf: string,
): { rows: AgeingRow[]; totals: AgeingRow } {
  const by = new Map<string, { b: Record<AgeingBucket, number>; onAccount: number }>();
  const tot = { b: emptyBuckets(), onAccount: 0 };
  for (const it of items) {
    const row = by.get(it.customerId) ?? { b: emptyBuckets(), onAccount: 0 };
    const f = fils(it.open);
    if (it.kind === "on_account") {
      row.onAccount -= f;
      tot.onAccount -= f;
    } else {
      const k = it.dueDate ? ageBucket(asOf, it.dueDate) : "current";
      row.b[k] += f;
      tot.b[k] += f;
    }
    by.set(it.customerId, row);
  }
  const out = (customerId: string, r: { b: Record<AgeingBucket, number>; onAccount: number }) => {
    const buckets = emptyBuckets();
    let total = r.onAccount;
    for (const k of Object.keys(buckets) as AgeingBucket[]) {
      buckets[k] = r.b[k] / 100;
      total += r.b[k];
    }
    return { customerId, buckets, onAccount: r.onAccount / 100, total: total / 100 };
  };
  return {
    rows: [...by.entries()].map(([id, r]) => out(id, r)).filter((r) => r.total !== 0 || r.onAccount !== 0),
    totals: out("", tot),
  };
}

export type StatementEntry = {
  date: string;
  kind: "invoice" | "credit_note" | "receipt";
  number: string;
  reference: string | null;
  debit: number;
  credit: number;
};

/** A customer statement: the opening balance, each entry with its running balance, and the closing balance. */
export function statementWithBalance(
  opening: number,
  entries: readonly StatementEntry[],
): {
  opening: number;
  rows: Array<StatementEntry & { balance: number }>;
  closing: number;
  debits: number;
  credits: number;
} {
  let bal = fils(opening);
  let dr = 0;
  let cr = 0;
  const rows = [...entries]
    .sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number))
    .map((e) => {
      bal += fils(e.debit) - fils(e.credit);
      dr += fils(e.debit);
      cr += fils(e.credit);
      return { ...e, balance: bal / 100 };
    });
  return { opening: fils(opening) / 100, rows, closing: bal / 100, debits: dr / 100, credits: cr / 100 };
}

/** Does issuing this document need a second person (accounting.journals.approve)? Above the threshold only. */
export function needsApproval(total: number, threshold: number): boolean {
  return fils(total) > fils(threshold);
}

export const SALES_ERRORS: Record<string, string> = {
  customer_unknown: "Choose an active customer.",
  customer_payer: "Only an insurer is linked to a payer, and the payer must exist.",
  receivable_account: "The receivable account must be an active receivables ledger.",
  income_account: "Each line needs an active income ledger.",
  sales_tax_code:
    "Each line needs an active sales tax code (standard, zero-rated, exempt or out of scope). The tax code is never guessed.",
  bad_line: "Check the quantity, price and discount on every line.",
  no_lines: "Add at least one line.",
  too_many_lines: "A document has at most 200 lines.",
  totals_mismatch: "The totals changed while you were editing. Reload and try again.",
  original_invoice:
    "A credit note refers to an issued invoice of the same customer that is not void.",
  credit_exceeds: "The credit note is more than what is left to credit on the invoice.",
  approval_required:
    "This document is above the approval limit: someone else with the journal approval permission must issue it.",
  has_receipts: "Receipts are allocated to this invoice. Remove the allocations first.",
  has_credit_notes:
    "Credit notes already exist for this invoice. Issue a credit note for the rest instead.",
  allocation_customer: "Allocate only to this customer's issued invoices on the same receivable account.",
  allocation_exceeds: "An allocation is more than the invoice's open amount.",
  over_allocated: "The allocations add up to more than the receipt.",
  receipt_account: "Choose an active bank, cash or clearing ledger to receive into.",
  zero_total: "The total must be above zero.",
};
