import { redactStatementText } from "@/lib/redact";

/**
 * Journals (Phase 22A), pure. The database (acc_journal_save / acc_post_journal / acc_post_from_source, migration
 * 20261108000100) is the authority; these rules let the form and the posting engine catch the same problems first, with
 * the same codes (lib/accounting/errors.ts turns a code into a sentence).
 */

export const VOUCHER_TYPES = [
  "journal",
  "contra",
  "payment",
  "receipt",
  "sales",
  "purchase",
  "credit_note",
  "debit_note",
  "opening",
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/** Types a person enters as a manual journal in 22A (sales, receipts, payments and purchases come from their own slices). */
export const MANUAL_VOUCHER_TYPES = [
  "journal",
  "contra",
  "credit_note",
  "debit_note",
  "opening",
] as const satisfies readonly VoucherType[];
export type ManualVoucherType = (typeof MANUAL_VOUCHER_TYPES)[number];

export const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  journal: "Journal",
  contra: "Contra",
  payment: "Payment",
  receipt: "Receipt",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit note",
  debit_note: "Debit note",
  opening: "Opening balance",
};

/** Sub-ledger items that post through acc_post_from_source (the CHECK list in the migration). */
export const SOURCE_KINDS = [
  "unite_invoice",
  "unite_payment",
  "supplier_invoice",
  "voucher",
  "remittance",
  "denial",
  "revshare_run",
  "lab_charge",
  "cashup",
  "settlement",
  "bank_line",
  "opening",
  "tally_import",
  "fixed_asset",
  "depreciation",
  "sales_invoice",
  "receipt",
  "payroll",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number] | "reversal";

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  unite_invoice: "Unite invoice",
  unite_payment: "Unite payment",
  supplier_invoice: "Supplier invoice",
  voucher: "Payment voucher",
  remittance: "Remittance",
  denial: "Denial",
  revshare_run: "Revenue-share run",
  lab_charge: "Lab charge",
  cashup: "Cash-up",
  settlement: "Settlement",
  bank_line: "Bank line",
  opening: "Opening balance",
  tally_import: "Tally import",
  fixed_asset: "Fixed asset",
  depreciation: "Depreciation",
  sales_invoice: "Sales invoice",
  receipt: "Receipt",
  payroll: "Payroll",
  reversal: "Reversal",
};

export type JournalStatus = "draft" | "posted" | "reversed";

export const STATUS_LABELS: Record<JournalStatus, string> = {
  draft: "Draft",
  posted: "Posted",
  reversed: "Reversed",
};

export const PARTY_KINDS = [
  "customer",
  "supplier",
  "payer",
  "doctor",
  "employee",
  "other",
] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/**
 * One line as acc_journal_save and acc_post_from_source take it (jsonb). Give the account by id or by code; amounts are
 * already rounded to 2 decimals and exactly one of debit / credit is above zero. Every other field is optional.
 */
export type JournalLineInput = {
  account_id?: string;
  account_code?: string;
  debit?: number;
  credit?: number;
  description?: string | null;
  tax_code_id?: string | null;
  tax_code?: string | null;
  branch_code?: string | null;
  department?: string | null;
  doctor_id?: string | null;
  payer_id?: string | null;
  supplier_id?: string | null;
  cost_centre_id?: string | null;
  cost_centre?: string | null;
  party_kind?: PartyKind | null;
  party_id?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
  amount_fx?: number | null;
};

export const MAX_LINES = 500;
export const MAX_NARRATION = 300;

/** Round half away from zero to 2 decimals, without floating drift (1.005 -> 1.01). */
export function roundMoney(n: number): number {
  if (!Number.isFinite(n)) return NaN;
  const sign = n < 0 ? -1 : 1;
  const cents = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  return (sign * cents) / 100;
}

/** "1,234.50" -> 1234.5; blank -> 0; anything else -> NaN. */
export function parseAmount(raw: string | number | null | undefined): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === "number") return raw;
  const t = raw.replace(/,/g, "").trim();
  if (t === "") return 0;
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** Amount in cents (integer), so sums never drift. */
const cents = (n: number) => Math.round(n * 100);

export type JournalProblem = { code: string; line?: number };

export type LineCheck = {
  accountId?: string | null;
  debit: number;
  credit: number;
  isGroup?: boolean;
  isActive?: boolean;
  control?: string | null;
  allowManual?: boolean;
};

/**
 * The line rules acc_validate() applies, for the form (live) and the posting engine (before calling the database):
 * at most 500 lines, an account on every line, positive amounts with at most 2 decimals, one side per line, at least two
 * lines, debits equal credits and above zero, no groups, no inactive accounts, and control accounts only for automatic
 * postings or an opening-balance journal. Returns every problem (the database stops at the first).
 */
export function validateJournal(
  lines: readonly LineCheck[],
  opts: { manual: boolean; voucherType: VoucherType },
): JournalProblem[] {
  const out: JournalProblem[] = [];
  if (lines.length > MAX_LINES) out.push({ code: "too_many_lines" });
  lines.forEach((l, i) => {
    const line = i + 1;
    if (!l.accountId) out.push({ code: "account_not_found", line });
    const bad = (v: number) => !Number.isFinite(v) || v < 0 || roundMoney(v) !== v || v >= 1e12;
    if (bad(l.debit) || bad(l.credit)) {
      out.push({ code: "bad_amount", line });
      return;
    }
    if (l.debit > 0 === l.credit > 0) out.push({ code: "one_sided", line });
    if (l.isGroup) out.push({ code: "account_is_group", line });
    if (l.isActive === false) out.push({ code: "account_inactive", line });
    if (opts.manual && opts.voucherType !== "opening") {
      if (l.control) out.push({ code: "control_account", line });
      else if (l.allowManual === false) out.push({ code: "manual_not_allowed", line });
    }
  });
  if (lines.length < 2) out.push({ code: "too_few_lines" });
  const t = journalTotals(lines);
  if (Number.isFinite(t.debit) && Number.isFinite(t.credit)) {
    if (t.difference !== 0) out.push({ code: "unbalanced" });
    else if (t.debit <= 0 && lines.length >= 2) out.push({ code: "zero_total" });
  }
  return out;
}

/** Debit and credit totals and their difference (debit - credit), summed in cents. */
export function journalTotals(lines: ReadonlyArray<{ debit: number; credit: number }>): {
  debit: number;
  credit: number;
  difference: number;
} {
  let d = 0;
  let c = 0;
  for (const l of lines) {
    d += cents(Number.isFinite(l.debit) ? l.debit : 0);
    c += cents(Number.isFinite(l.credit) ? l.credit : 0);
  }
  return { debit: d / 100, credit: c / 100, difference: (d - c) / 100 };
}

/**
 * Narration as it is stored: one line, at most 300 characters, with IBANs, card and account numbers, phone numbers and
 * e-mail addresses masked (a narration is about money, never about a patient). Null when nothing is left.
 */
export function cleanNarration(raw: string | null | undefined): string | null {
  return redactStatementText(raw, MAX_NARRATION);
}

/** The same rule for a line description (200 characters). */
export function cleanDescription(raw: string | null | undefined): string | null {
  return redactStatementText(raw, 200);
}

export function isManualVoucherType(v: string): v is ManualVoucherType {
  return (MANUAL_VOUCHER_TYPES as readonly string[]).includes(v);
}
