/**
 * The Tally bridge's sources (Phase 22J), pure and free of Node modules so the settings form can import it: what may be
 * pushed, the defaults, labels, and which builder each source uses. The rest is in bridge.ts.
 */

/** Sources the clinic may choose to push (Settings on the Tally bridge page). */
export const PUSH_SOURCES = [
  "supplier_invoice",
  "voucher",
  "sales_invoice",
  "receipt",
  "bank_transfer",
  "bank_entry",
  "petty_cash",
  "cheque",
  "fixed_asset",
  "unite_invoice",
  "unite_payment",
  "remittance",
  "denial",
  "revshare_run",
  "lab_charge",
  "cashup",
  "settlement",
] as const;
export type PushSource = (typeof PUSH_SOURCES)[number];

/** What the bridge sends unless the clinic changes it: the items Pulse originates that Tally must hold (22J design). */
export const DEFAULT_PUSH_SOURCES: readonly PushSource[] = [
  "supplier_invoice",
  "voucher",
  "sales_invoice",
  "receipt",
  "bank_transfer",
  "bank_entry",
  "cheque",
  "fixed_asset",
  "unite_invoice",
];

export const PUSH_SOURCE_LABELS: Record<PushSource, string> = {
  supplier_invoice: "Supplier invoices (bills)",
  voucher: "Payment vouchers",
  sales_invoice: "Sales invoices and credit notes",
  receipt: "Receipts",
  bank_transfer: "Bank transfers (Contra)",
  bank_entry: "Bank entries (charges, interest, direct debits)",
  petty_cash: "Petty cash expenses",
  cheque: "Cheques",
  fixed_asset: "Depreciation and schedule runs",
  unite_invoice: "Unite revenue (invoices)",
  unite_payment: "Unite payments and refunds",
  remittance: "Insurance remittances",
  denial: "Final insurance denials",
  revshare_run: "Doctor revenue share",
  lab_charge: "Lab and referral statements",
  cashup: "Cash-up differences",
  settlement: "Card and wallet settlements",
};

/** Sources whose journal comes from the 22D posting engine (buildJournalForSource). */
export const ENGINE_SOURCES = [
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
] as const;
/** Sources whose journal the database captures from the slice's own posting code (22E, 22F) or run lines (22H). */
export const CAPTURED_SOURCES = [
  "sales_invoice",
  "receipt",
  "bank_transfer",
  "bank_entry",
  "petty_cash",
  "cheque",
  "fixed_asset",
] as const;

/** Unite revenue and payments sent as one voucher per day and branch (OQ-124 default). */
export const DAY_KINDS = {
  unite_invoice: "unite_invoice_day",
  unite_payment: "unite_payment_day",
} as const;
export type DayKind = (typeof DAY_KINDS)[keyof typeof DAY_KINDS];

export type PushKind = PushSource | DayKind;

/** Short codes inside a REMOTEID. */
export const KIND_CODES: Record<PushKind, string> = {
  unite_invoice: "ui",
  unite_payment: "up",
  supplier_invoice: "si",
  voucher: "pv",
  remittance: "rm",
  denial: "dn",
  revshare_run: "rs",
  lab_charge: "lc",
  cashup: "cu",
  settlement: "st",
  sales_invoice: "sa",
  receipt: "rc",
  bank_transfer: "bt",
  bank_entry: "be",
  petty_cash: "pc",
  cheque: "cq",
  fixed_asset: "fa",
  unite_invoice_day: "uid",
  unite_payment_day: "upd",
};
