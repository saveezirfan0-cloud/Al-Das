import { SALES_ERRORS } from "@/lib/accounting/sales";

/**
 * The stable codes the accounting functions put in the error HINT (migration 20261108000100), as sentences for people.
 * Unknown codes fall back to the caller's sentence; the database message itself is never shown.
 */
export const ACCOUNTING_ERRORS: Record<string, string> = {
  not_permitted: "You do not have permission for that.",
  not_found: "That was not found. Reload the page.",
  wrong_status: "That is not possible in the journal's current state. Reload the page.",
  same_person: "A different person from the one who prepared the journal must do this.",
  not_submitted: "The maker has not submitted this journal yet.",
  hash_mismatch: "The journal changed since you opened it. Reload and review it again.",
  remarks_required: "Write a short reason (at least 3 characters).",
  too_few_lines: "A journal needs at least two lines.",
  too_many_lines: "A journal has at most 500 lines.",
  unbalanced: "Debits and credits must be equal.",
  zero_total: "A journal needs an amount above zero.",
  bad_amount: "Amounts are positive with at most two decimals.",
  one_sided: "Each line has either a debit or a credit, not both.",
  account_not_found: "Choose an account on every line.",
  account_is_group: "Post to a ledger account, not to a group.",
  account_inactive: "One of the accounts is inactive.",
  account_entity: "One of the accounts belongs to another entity.",
  control_account:
    "Control accounts (receivables, payables, bank, cash, VAT, clearing, retained earnings) take automatic postings only, or an opening-balance journal.",
  manual_not_allowed: "One of the accounts takes no manual journals.",
  tax_code: "A tax code is unknown or inactive.",
  cost_centre: "A cost centre is unknown or inactive.",
  supplier_unknown: "A supplier is unknown.",
  branch_unknown: "A branch is unknown.",
  branch_entity: "A branch on the journal books into another entity.",
  doctor_unknown: "A doctor is unknown.",
  payer_unknown: "A payer is unknown.",
  period_locked: "The period of this date is locked. Nothing can be posted into it.",
  period_closed:
    "The period of this date is closed. Only someone who manages periods can post into it.",
  month_locked: "The month of this date was signed off by the CEO and is locked.",
  adjustment_date: "An adjustment journal is dated the last day of the fiscal year.",
  adjustment_period: "Only someone who manages periods posts to the adjustment period.",
  voucher_type_not_manual: "That voucher type is not entered as a manual journal.",
  entity_unknown: "The entity was not found or is inactive.",
  source_kind: "Unknown source.",
  stale_version: "A newer version of this item is already posted.",
  already_reversed: "This journal is already reversed.",
  is_reversal: "A reversal is not reversed again; post a new journal instead.",
  reversal_before_original: "A reversal cannot be dated before the journal it reverses.",
  posted_immutable: "A posted journal cannot change; reverse it instead.",
  system_group: "Tally's predefined groups keep their code, place and nature.",
  has_lines: "This account has journal lines. Deactivate it instead.",
  has_children: "This group still holds accounts.",
  nature_mismatch: "An account has the nature of its group.",
  parent_not_group: "Choose a group as the parent.",
  cycle: "A group cannot sit inside itself.",
  fy_in_use: "The fiscal year start cannot change once a fiscal year exists.",
  period_status: "That period change is not possible (close a period before locking it).",
  invalid: "Check the form and try again.",
  // Phase 22E receivables (lib/accounting/sales.ts)
  ...SALES_ERRORS,
  // Phase 22D: the ledger start and the posting engine (migration 20261109000100, lib/accounting/posting)
  before_ledger_start:
    "This is dated before the ledger start. Until then Tally is the book of record, so Pulse does not post it.",
  ledger_start_in_use:
    "Pulse has already posted journals: the ledger start cannot be cleared, moved earlier, or moved past the first one.",
  no_rule: "A posting rule is missing. Add it under Posting rules.",
  no_tax_code:
    "A service category has no VAT code yet. The tax adviser decides it (OQ-120); add it under Posting rules.",
  vat_mismatch: "The VAT on the item does not fit its tax code.",
  claims_exceed_invoice: "The claims matched to this invoice add up to more than the invoice.",
  package_deferral: "Package invoices are held until packages are set up (OQ-127).",
  no_date: "The item has no date.",
  foreign_currency: "The item is in a foreign currency; it is not posted automatically.",
  error: "Something went wrong. It will be tried again.",
  // budgets (Phase 22G)
  budget_approved: "An approved budget cannot change. Reopen it first.",
  budget_account: "Budgets take active income and expense ledgers only.",
  budget_month: "A month is outside the budget's fiscal year.",
  budget_same_person: "A different person from the one who prepared the budget must approve it.",
  budget_hash_mismatch: "The budget changed since you opened it. Reload and review it again.",
  budget_empty: "The budget has no lines yet.",
  duplicate_line: "The same account, month, branch and department appear twice.",
};

export function accountingErrorMessage(code: string | null | undefined, fallback: string): string {
  return (code && ACCOUNTING_ERRORS[code]) || fallback;
}

/** A database error (PostgREST shape) as a sentence. Looks at the HINT and SQLSTATE only, never at message text. */
export function rpcErrorMessage(
  err: { code?: string; hint?: string | null } | null | undefined,
  fallback: string,
): string {
  if (err?.hint && ACCOUNTING_ERRORS[err.hint]) return ACCOUNTING_ERRORS[err.hint];
  if (err?.code === "23505") return "That code or name is already used.";
  if (err?.code === "23503") return "That is still in use.";
  if (err?.code === "42501") return ACCOUNTING_ERRORS.posted_immutable;
  return fallback;
}
