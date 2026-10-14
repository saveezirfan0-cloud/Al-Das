import { roundMoney } from "@/lib/accounting/journal";
import { rpcErrorMessage } from "@/lib/accounting/errors";

/**
 * Banking and cash (Phase 22F), the pure rules. The database (migration 20261109000300) enforces the same rules in
 * SQL; these functions let the forms refuse early and the pages explain the figures. Unit-tested in
 * tests/unit/accounting/banking.test.ts.
 */

// ---- transfers (Contra) -----------------------------------------------------------------------------------------

export const TRANSFER_KINDS = [
  "transfer",
  "cash_deposit",
  "cash_withdrawal",
  "petty_cash_topup",
] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

export const TRANSFER_LABELS: Record<TransferKind, string> = {
  transfer: "Transfer between accounts",
  cash_deposit: "Cash deposited in the bank",
  cash_withdrawal: "Cash withdrawn from the bank",
  petty_cash_topup: "Petty cash top-up",
};

/** A bank or cash ledger as a transfer sees it. */
export type MoneyAccount = { id: string; control: "bank" | "cash" | string | null };

export type TransferInput = {
  kind: TransferKind;
  from: MoneyAccount | null;
  to: MoneyAccount | null;
  amount: number;
};

/** The first reason a transfer would be refused (the same codes as the database), or null. */
export function transferProblem(t: TransferInput): string | null {
  if (!Number.isFinite(t.amount) || t.amount <= 0 || roundMoney(t.amount) !== t.amount)
    return "bad_amount";
  const isMoney = (a: MoneyAccount | null) => !!a && (a.control === "bank" || a.control === "cash");
  if (!isMoney(t.from) || !isMoney(t.to)) return "not_money_account";
  if (t.from!.id === t.to!.id) return "same_account";
  if (t.kind === "cash_deposit" && (t.from!.control !== "cash" || t.to!.control !== "bank"))
    return "transfer_direction";
  if (t.kind === "cash_withdrawal" && (t.from!.control !== "bank" || t.to!.control !== "cash"))
    return "transfer_direction";
  return null;
}

// ---- bank entries ------------------------------------------------------------------------------------------------

export const ENTRY_KINDS = [
  "bank_charge",
  "interest_paid",
  "direct_debit",
  "interest_received",
  "direct_credit",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_LABELS: Record<EntryKind, string> = {
  bank_charge: "Bank charge",
  interest_paid: "Interest paid",
  direct_debit: "Direct debit",
  interest_received: "Interest received",
  direct_credit: "Direct credit",
};

/** Money into the bank (Dr bank) or out of it (Cr bank). */
export const entryIsMoneyIn = (kind: EntryKind) =>
  kind === "interest_received" || kind === "direct_credit";

/** The kind a statement line suggests: a credit is interest or a direct credit, a debit a charge or direct debit. */
export function suggestedEntryKind(lineAmount: number): EntryKind {
  return lineAmount > 0 ? "direct_credit" : "bank_charge";
}

export type TaxCodeLike = { kind: string; rate: number };

/**
 * How a gross amount splits when its tax code is standard-rated (VAT included in the amount, as on a bank statement or
 * a till receipt): net = round(amount x 100 / (100 + rate)), VAT = the rest. Any other code keeps the whole amount on
 * the ledger. Reverse charge is refused (null): it needs both VAT sides, so it is entered as a journal.
 */
export function vatSplit(
  amount: number,
  tax: TaxCodeLike | null,
): { net: number; vat: number } | null {
  if (tax?.kind === "reverse_charge") return null;
  if (!tax || tax.kind !== "standard" || !(tax.rate > 0)) return { net: amount, vat: 0 };
  const net = roundMoney((amount * 100) / (100 + tax.rate));
  return { net, vat: roundMoney(amount - net) };
}

// ---- cheques -----------------------------------------------------------------------------------------------------

export const CHEQUE_STATUSES = [
  "issued",
  "received",
  "presented",
  "cleared",
  "bounced",
  "cancelled",
  "stale",
] as const;
export type ChequeStatus = (typeof CHEQUE_STATUSES)[number];

export const CHEQUE_STATUS_LABELS: Record<ChequeStatus, string> = {
  issued: "Issued",
  received: "Received",
  presented: "Presented",
  cleared: "Cleared",
  bounced: "Bounced",
  cancelled: "Cancelled",
  stale: "Stale",
};

export const CHEQUE_ACTIONS = ["present", "clear", "bounce", "cancel", "stale"] as const;
export type ChequeAction = (typeof CHEQUE_ACTIONS)[number];

/** The same table as public.acc_cheque_act: from which statuses each step is possible, and where it leads. */
export const CHEQUE_TRANSITIONS: Record<
  ChequeAction,
  { from: readonly ChequeStatus[]; to: ChequeStatus }
> = {
  present: { from: ["issued", "received"], to: "presented" },
  clear: { from: ["issued", "received", "presented"], to: "cleared" },
  bounce: { from: ["issued", "received", "presented", "cleared"], to: "bounced" },
  cancel: { from: ["issued", "received"], to: "cancelled" },
  stale: { from: ["issued", "received"], to: "stale" },
};

export const FINAL_CHEQUE_STATUSES: readonly ChequeStatus[] = ["bounced", "cancelled", "stale"];

export function nextChequeStatus(status: ChequeStatus, action: ChequeAction): ChequeStatus | null {
  const t = CHEQUE_TRANSITIONS[action];
  return t.from.includes(status) ? t.to : null;
}

/** The steps a person may take on a cheque today (the stale step only once it is stale). */
export function availableChequeActions(
  c: { status: ChequeStatus; chequeDate: string },
  today: string,
): ChequeAction[] {
  return CHEQUE_ACTIONS.filter(
    (a) => chequeActionProblem({ ...c, action: a, date: today, today }) === null,
  );
}

/** YYYY-MM-DD plus whole months, the day clamped to the month's end (as Postgres adds an interval of months). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

/** A cheque is valid for six months from its date (UAE practice); after that it is stale. */
export const STALE_MONTHS = 6;

export const staleFrom = (chequeDate: string) => addMonths(chequeDate, STALE_MONTHS);

/** Stale on `today`: strictly after the six months. */
export const isStale = (chequeDate: string, today: string) => today > staleFrom(chequeDate);

/** Post-dated: the date written on it is after the day it was written out or received. */
export const isPostDated = (chequeDate: string, recordedOn: string) => chequeDate > recordedOn;

/** Is the cheque's posting due on `today` (its date has come)? */
export const isDue = (chequeDate: string, today: string) => chequeDate <= today;

/** The first reason a step would be refused (the database's codes), or null. */
export function chequeActionProblem(c: {
  status: ChequeStatus;
  chequeDate: string;
  action: ChequeAction;
  date: string;
  today: string;
  reason?: string | null;
}): string | null {
  const to = nextChequeStatus(c.status, c.action);
  if (!to) return "cheque_transition";
  if (c.date > c.today) return "date_future";
  if ((to === "presented" || to === "cleared" || to === "bounced") && c.date < c.chequeDate)
    return "cheque_not_due";
  if (to === "stale" && !isStale(c.chequeDate, c.date)) return "cheque_not_stale";
  if (
    (to === "bounced" || to === "cancelled") &&
    c.reason !== undefined &&
    (c.reason ?? "").trim().length < 3
  )
    return "remarks_required";
  return null;
}

export const PARTY_KINDS = [
  "supplier",
  "payer",
  "customer",
  "doctor",
  "employee",
  "patient",
  "other",
] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const PARTY_LABELS: Record<PartyKind, string> = {
  supplier: "Supplier",
  payer: "Insurer or payer",
  customer: "Customer",
  doctor: "Doctor",
  employee: "Employee",
  patient: "Patient (Unite PIN only)",
  other: "Other",
};

/** A patient is recorded by the Unite PIN only, never by name. */
export const isPatientPin = (v: string) => /^[A-Za-z0-9-]{1,20}$/.test(v);

/** The next leaf of a cheque book, zero-padded to the book's width; null when the book is used up. */
export function nextLeaf(book: {
  nextNumber: number;
  lastNumber: number;
  width: number;
}): string | null {
  if (book.nextNumber > book.lastNumber) return null;
  return String(book.nextNumber).padStart(book.width, "0");
}

// ---- petty cash --------------------------------------------------------------------------------------------------

export type CountResult = {
  difference: number;
  state: "balanced" | "short" | "over";
  needsExplanation: boolean;
};

/** The monthly count against the book: counted minus book; a difference needs an explanation. */
export function pettyCashCount(counted: number, book: number): CountResult {
  const difference = roundMoney(counted - book);
  return {
    difference,
    state: difference === 0 ? "balanced" : difference < 0 ? "short" : "over",
    needsExplanation: difference !== 0,
  };
}

/** What a top-up should be to bring the float back to its imprest amount (never negative). */
export function topUpNeeded(imprest: number, book: number): number {
  return Math.max(0, roundMoney(imprest - book));
}

/** The first of the month holding a date. */
export const monthOf = (date: string) => `${date.slice(0, 7)}-01`;

// ---- bank position (book to bank) --------------------------------------------------------------------------------

export type BookToBankInput = {
  /** Ledger balance at the statement date (debit minus credit: positive in funds). */
  glAtStatement: number;
  /** As printed by the bank on that date (positive in funds, negative overdrawn). */
  statementBalance: number;
  /** Cheques we issued that are in the books but not yet through the bank. */
  unclearedIssued: number;
  /** Cheques we received and booked that the bank has not credited yet. */
  unclearedReceived: number;
};

export type BookToBankResult = {
  /** The book balance adjusted for uncleared cheques: what the bank should show. */
  expectedBank: number;
  /** Statement minus expected: what is still unexplained (bank items not in the books, errors). */
  difference: number;
  reconciled: boolean;
};

/**
 * Book-to-bank reconciliation: an issued cheque has left the books but not the bank (add it back), a received cheque is
 * in the books but not yet in the bank (take it off). Whatever is left is a bank item the books do not have yet (charges,
 * direct debits, unmatched receipts) or an error.
 */
export function bookToBank(i: BookToBankInput): BookToBankResult {
  const expectedBank = roundMoney(i.glAtStatement + i.unclearedIssued - i.unclearedReceived);
  const difference = roundMoney(i.statementBalance - expectedBank);
  return { expectedBank, difference, reconciled: difference === 0 };
}

// ---- codes and messages ------------------------------------------------------------------------------------------

/** A ledger code suggestion: the prefix and the first free number after it. */
export function suggestCode(prefix: string, taken: readonly string[], start = 1): string {
  const used = new Set(taken.map((c) => c.toUpperCase()));
  for (let n = start; n < start + 1000; n++) {
    const code = `${prefix}${n}`;
    if (!used.has(code)) return code;
  }
  return `${prefix}${start}`;
}

export const BANKING_ERRORS: Record<string, string> = {
  banking_immutable: "Banking records never change. Cancel it and enter it again.",
  not_money_account: "Choose an active bank or cash ledger.",
  not_bank_ledger: "Choose a bank ledger (a ledger marked as a bank control account).",
  bank_not_linked:
    "Link this bank account to its ledger first (Accounting, Banking, Bank accounts).",
  ledger_in_use: "That ledger already belongs to another bank account.",
  already_linked: "This bank account already has its ledger.",
  same_account: "Choose two different accounts.",
  transfer_direction:
    "A cash deposit moves cash into a bank; a withdrawal moves money from a bank to cash.",
  counter_not_allowed:
    "That control account cannot be used here. Choose an expense, income or other ledger.",
  tax_code_not_allowed: "Reverse-charge VAT is entered as a journal.",
  line_mismatch: "The entry must have the statement line's account, date, amount and direction.",
  line_matched: "That statement line is already matched.",
  document_unknown: "The receipt was not found. Upload it again.",
  explanation_required: "Explain the difference between the count and the book.",
  count_signed: "This month's count is already signed.",
  count_stale: "The book balance changed since the count. Prepare the count again.",
  book_overlap: "That range overlaps another cheque book of the account.",
  book_invalid: "Choose an active cheque book of this account, and a number inside it.",
  book_exhausted: "This cheque book is used up.",
  cheque_no: "Enter the cheque number (digits only).",
  cheque_duplicate: "That cheque is already in the register.",
  cheque_stale: "A cheque older than six months is stale and cannot be registered.",
  cheque_transition: "That step is not possible for this cheque now. Reload the page.",
  cheque_not_due: "A post-dated cheque cannot be presented, cleared or bounced before its date.",
  cheque_not_stale: "A cheque goes stale only six months after its date.",
  date_future: "The date cannot be in the future.",
  party_invalid: "Say who the cheque is from or to.",
  party_patient: "A patient is recorded by the Unite PIN only, never by name.",
  voucher_mismatch: "That voucher is not an approved cheque payment of this amount.",
  before_ledger_start: "That date is before the ledger starts.",
};

/** A database error as a sentence: the banking codes first, then the ledger's. Never the raw message. */
export function bankingErrorMessage(
  err: { code?: string; hint?: string | null } | null | undefined,
  fallback: string,
): string {
  if (err?.hint && BANKING_ERRORS[err.hint]) return BANKING_ERRORS[err.hint];
  if (err?.code === "42501" && !err.hint) return BANKING_ERRORS.banking_immutable;
  return rpcErrorMessage(err, fallback);
}

/** What a posting outcome means for the person. */
export function postingMessage(status: string | null | undefined, done: string): string {
  return status === "waiting_ledger_start"
    ? `${done} It waits until the ledger starts and posts automatically then.`
    : `${done} Posted.`;
}
