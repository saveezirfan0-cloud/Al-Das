/**
 * The field list of each kind of imported file (pure). A file layout ("format", table fin_import_formats) maps each field
 * to the header text of one column; the parser reads ONLY those columns. Adding a kind later (POS files) means adding it
 * here, to the check constraint of fin_import_formats.kind and to a parser.
 *
 * The lab and provider kinds (20E) deliberately have NO field for a patient's name, date of birth, Emirates ID or
 * insurance member id: those columns can never be mapped, so they are never read. The PIN is the Unite PIN only.
 * The insurer receipt register kind (matching v2) is the same: one row per insurer payment (reference, amount, bank
 * receipt date, payer, receipt number, bank) with NO field for a patient name, ID number or member id.
 */

export const IMPORT_KIND_KEYS = [
  "bank_statement",
  "settlement",
  "lab_activity",
  "provider_invoice",
  "receipt_register",
] as const;
export type ImportKind = (typeof IMPORT_KIND_KEYS)[number];

/** The kinds each settings page offers: bank reconciliation (20C) and labs and referrals (20E). */
export const BANK_IMPORT_KINDS = [
  "bank_statement",
  "settlement",
] as const satisfies readonly ImportKind[];
export const LAB_IMPORT_KINDS = [
  "lab_activity",
  "provider_invoice",
] as const satisfies readonly ImportKind[];
export type LabImportKind = (typeof LAB_IMPORT_KINDS)[number];
/** The kind the matching page imports (insurer payments seen in the bank). */
export const RECEIPT_IMPORT_KINDS = ["receipt_register"] as const satisfies readonly ImportKind[];
export type ReceiptImportKind = (typeof RECEIPT_IMPORT_KINDS)[number];

export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const AMOUNT_STYLES = ["signed", "debit_credit"] as const;
export type AmountStyle = (typeof AMOUNT_STYLES)[number];

export type FieldType = "date" | "amount" | "text";
/** always = required in every layout; signed / debit_credit = required only with that amount style. */
export type Requirement = "always" | "optional" | AmountStyle;
export type FieldSpec = { label: string; type: FieldType; requirement: Requirement; hint?: string };

export const IMPORT_KINDS = {
  bank_statement: {
    label: "Bank statement",
    usesAmountStyle: true,
    fields: {
      value_date: { label: "Value date", type: "date", requirement: "always" },
      amount: {
        label: "Amount (signed)",
        type: "amount",
        requirement: "signed",
        hint: "One column: money in is positive, money out negative.",
      },
      credit: { label: "Credit (money in)", type: "amount", requirement: "debit_credit" },
      debit: { label: "Debit (money out)", type: "amount", requirement: "debit_credit" },
      reference: { label: "Reference", type: "text", requirement: "optional" },
      description: {
        label: "Description",
        type: "text",
        requirement: "optional",
        hint: "Card and account numbers are masked before it is stored.",
      },
    },
  },
  settlement: {
    label: "Processor settlement report",
    usesAmountStyle: false,
    fields: {
      transaction_date: { label: "Transaction date", type: "date", requirement: "always" },
      settlement_date: { label: "Settlement (payout) date", type: "date", requirement: "always" },
      gross: { label: "Gross amount", type: "amount", requirement: "always" },
      net: { label: "Net amount paid out", type: "amount", requirement: "always" },
      fee: {
        label: "Fee",
        type: "amount",
        requirement: "optional",
        hint: "Without a fee column the fee is gross minus net.",
      },
      reference: {
        label: "Payout or batch reference",
        type: "text",
        requirement: "optional",
      },
    },
  },
  lab_activity: {
    label: "Lab activity report (in-house lab)",
    usesAmountStyle: false,
    fields: {
      service_date: { label: "Service (sample) date", type: "date", requirement: "always" },
      test_code: {
        label: "Test code (CPT or Unite item code)",
        type: "text",
        requirement: "always",
      },
      patient_pin: {
        label: "Unite PIN",
        type: "text",
        requirement: "optional",
        hint: "The Unite PIN only. There is no field for a name or an ID number, so those columns are never read.",
      },
      doctor_dha_id: { label: "Ordering doctor's DHA id", type: "text", requirement: "optional" },
      branch: {
        label: "Branch",
        type: "text",
        requirement: "optional",
        hint: "A branch code or name from Reference data.",
      },
      result_date: {
        label: "Result date",
        type: "date",
        requirement: "optional",
        hint: "Needed for the turnaround report.",
      },
    },
  },
  provider_invoice: {
    label: "Provider invoice (send-out lab, hospital, radiology)",
    usesAmountStyle: false,
    fields: {
      service_date: { label: "Service date", type: "date", requirement: "always" },
      test_code: {
        label: "Test or service code (CPT or Unite item code)",
        type: "text",
        requirement: "always",
      },
      amount: { label: "Amount charged", type: "amount", requirement: "always" },
      patient_pin: {
        label: "Unite PIN",
        type: "text",
        requirement: "optional",
        hint: "The Unite PIN only. There is no field for a name or an ID number, so those columns are never read.",
      },
      doctor_dha_id: { label: "Ordering doctor's DHA id", type: "text", requirement: "optional" },
      branch: {
        label: "Branch",
        type: "text",
        requirement: "optional",
        hint: "A branch code or name from Reference data.",
      },
      result_date: { label: "Result date", type: "date", requirement: "optional" },
      invoice_number: { label: "Invoice number", type: "text", requirement: "optional" },
    },
  },
  receipt_register: {
    label: "Insurer receipt register",
    usesAmountStyle: false,
    fields: {
      payment_ref: {
        label: "Payment reference",
        type: "text",
        requirement: "always",
        hint: "Diligence Remittance Receipt Report: PaymentReference.",
      },
      amount: {
        label: "Amount received",
        type: "amount",
        requirement: "always",
        hint: "Diligence: BankAmount (0 until the money reaches the bank, so pending advices are skipped).",
      },
      receipt_date: {
        label: "Bank receipt date",
        type: "date",
        requirement: "always",
        hint: "Diligence: BankReceiptDate (any date layout reads it).",
      },
      payer: {
        label: "Insurer or payer",
        type: "text",
        requirement: "optional",
        hint: "Diligence: ReceiverID.",
      },
      receipt_no: {
        label: "Bank receipt number",
        type: "text",
        requirement: "optional",
        hint: "Diligence: BankReceiptNo.",
      },
      bank_name: {
        label: "Bank",
        type: "text",
        requirement: "optional",
        hint: "Diligence: BankName.",
      },
    },
  },
} as const satisfies Record<
  ImportKind,
  { label: string; usesAmountStyle: boolean; fields: Record<string, FieldSpec> }
>;

export type ImportFormat = {
  kind: ImportKind;
  mapping: Record<string, string>;
  dateFormat: DateFormat;
  amountStyle: AmountStyle;
};

export const isImportKind = (v: unknown): v is ImportKind =>
  typeof v === "string" && (IMPORT_KIND_KEYS as readonly string[]).includes(v);
export const isBankImportKind = (v: unknown): v is (typeof BANK_IMPORT_KINDS)[number] =>
  typeof v === "string" && (BANK_IMPORT_KINDS as readonly string[]).includes(v);
export const isLabImportKind = (v: unknown): v is LabImportKind =>
  typeof v === "string" && (LAB_IMPORT_KINDS as readonly string[]).includes(v);
export const isReceiptImportKind = (v: unknown): v is ReceiptImportKind =>
  typeof v === "string" && (RECEIPT_IMPORT_KINDS as readonly string[]).includes(v);

/** The fields a layout of this kind uses with this amount style, and whether each must be mapped. */
export function fieldsFor(
  kind: ImportKind,
  style: AmountStyle,
): Array<{ key: string; spec: FieldSpec; required: boolean }> {
  const fields = IMPORT_KINDS[kind].fields as Record<string, FieldSpec>;
  const styled = IMPORT_KINDS[kind].usesAmountStyle;
  return Object.entries(fields)
    .filter(
      ([, spec]) =>
        !styled ||
        spec.requirement === "always" ||
        spec.requirement === "optional" ||
        spec.requirement === style,
    )
    .map(([key, spec]) => ({
      key,
      spec,
      required: spec.requirement === "always" || (styled && spec.requirement === style),
    }));
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Normalised header text: case, surrounding and repeated spaces do not matter. */
export const headerKey = squash;

/**
 * Checks a column mapping typed by a person. Keeps only this kind's fields (for this amount style), trims the header
 * texts, refuses a missing required field and two fields mapped to the same column.
 */
export function validateMapping(
  kind: ImportKind,
  style: AmountStyle,
  raw: Record<string, unknown>,
): { ok: true; mapping: Record<string, string> } | { ok: false; error: string } {
  const mapping: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const { key, spec, required } of fieldsFor(kind, style)) {
    const v = typeof raw[key] === "string" ? (raw[key] as string).replace(/\s+/g, " ").trim() : "";
    if (v === "") {
      if (required) return { ok: false, error: `Give the column header for "${spec.label}".` };
      continue;
    }
    if (v.length > 80)
      return { ok: false, error: `The header for "${spec.label}" is longer than 80 characters.` };
    const k = squash(v);
    if (seen.has(k))
      return {
        ok: false,
        error: `"${spec.label}" and "${seen.get(k)}" cannot use the same column.`,
      };
    seen.set(k, spec.label);
    mapping[key] = v;
  }
  return { ok: true, mapping };
}
