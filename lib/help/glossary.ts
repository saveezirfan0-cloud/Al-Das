/**
 * Plain-words glossary for finance and accounting terms (Phase D). `<Term k="accrual">` (components/shell/term.tsx)
 * shows the meaning in a tooltip. Short, no jargon inside the explanation, no patient data. A new term goes here first;
 * a test checks every key used in the app exists.
 */
export type GlossaryEntry = { term: string; meaning: string };

export const GLOSSARY = {
  accrual: {
    term: "Accrual",
    meaning:
      "Income or a cost counted in the month it was earned or used, even if the money moves later.",
  },
  debit: {
    term: "Debit",
    meaning:
      "The left side of an entry. It increases what the clinic owns or spends, and reduces what it owes or earns.",
  },
  credit: {
    term: "Credit",
    meaning:
      "The right side of an entry. It increases what the clinic owes or earns, and reduces what it owns or spends.",
  },
  journal: {
    term: "Journal",
    meaning:
      "One recorded money event, written as debits and credits that add up to the same total.",
  },
  ledger: {
    term: "General ledger",
    meaning: "Every posted entry, grouped by account: the clinic's complete book.",
  },
  "trial-balance": {
    term: "Trial balance",
    meaning:
      "Each account's total debits and credits on a date. The two columns must be equal; if not, something is wrong.",
  },
  receivable: {
    term: "Receivable",
    meaning: "Money others owe the clinic, such as an insurer or a company, for work already done.",
  },
  payable: {
    term: "Payable",
    meaning: "Money the clinic owes suppliers for goods or services it has already received.",
  },
  ageing: {
    term: "Ageing",
    meaning:
      "Unpaid amounts sorted by how long they have been waiting, e.g. 0–30, 31–60 and over 90 days.",
  },
  "on-account": {
    term: "On account",
    meaning: "Money received but not yet matched to a particular invoice.",
  },
  "retained-earnings": {
    term: "Retained earnings",
    meaning:
      "Profit from earlier years that stays in the business. The year-end close moves profit here.",
  },
  depreciation: {
    term: "Depreciation",
    meaning:
      "Spreading the cost of equipment over the years it is used, a little each month, instead of all at once.",
  },
  equity: {
    term: "Equity",
    meaning: "What the owners have in the business: what it owns minus what it owes.",
  },
  "vat-output": {
    term: "Output VAT",
    meaning: "VAT the clinic charged on its own sales. It is owed to the tax authority.",
  },
  "vat-input": {
    term: "Input VAT",
    meaning: "VAT the clinic paid on purchases. It can usually be taken off the VAT owed.",
  },
  reconciliation: {
    term: "Reconciliation",
    meaning:
      "Checking two records of the same money agree, e.g. the bank statement against the ledger, and explaining any gap.",
  },
  "cash-flow": {
    term: "Cash flow",
    meaning:
      "Where cash came from and where it went in a period. Profit and cash are not the same thing.",
  },
  provisional: {
    term: "Provisional",
    meaning: "A figure that can still change, because its month is not closed or approved yet.",
  },
  "open-item": {
    term: "Open item",
    meaning:
      "A payment still waiting to be received in full. It stays on the list, with what is left, until it is fully matched, written off with a reason or cancelled.",
  },
  allocation: {
    term: "Allocation",
    meaning:
      "The part of one bank deposit that pays one insurer payment. A deposit can pay several payments, and a payment can be paid by several deposits.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossaryKey = keyof typeof GLOSSARY;

export function glossaryEntry(k: string): GlossaryEntry | null {
  return Object.prototype.hasOwnProperty.call(GLOSSARY, k) ? GLOSSARY[k as GlossaryKey] : null;
}
