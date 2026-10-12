import type { FieldSpec } from "@/lib/finance/unite-mapping";
import { DILIGENCE_SENSITIVE_HEADERS } from "@/lib/finance/diligence-mapping";

/**
 * The ONLY place that knows the column names of a payer's payment advice (remittance) file.
 *
 * No real advice is in the repo (it carries patient names and member IDs), so the first alias of each column is a
 * plausible name taken from the Diligence report and the project brief. When the first real file arrives, adjust the
 * aliases here: the upload screen lists every header it did not recognise. Columns are matched ignoring case, spaces,
 * underscores and dashes. A column that is not listed here is NEVER read or stored.
 */

export type RemitKind = "string" | "number" | "date";
export type RemitField = FieldSpec & { kind: RemitKind };

const f = (kind: RemitKind, aliases: string[], required = false): RemitField => ({
  kind,
  aliases,
  required,
});

export const REMITTANCE_FIELDS = {
  remittance_ref: f(
    "string",
    [
      "RemittanceID",
      "RemittanceNo",
      "RemittanceReference",
      "PaymentReference",
      "PaymentRef",
      "AdviceNo",
    ],
    true,
  ),
  paid_on: f("date", ["PaymentDate", "RemittanceDate", "SettlementDate", "DatePaid"]),
  payer_id: f("string", ["PayerID", "PayerId"]),
  claim_activity_number: f("string", [
    "ClaimActivityNumber",
    "ClaimActivityNo",
    "ActivityNumber",
    "ActivityID",
  ]),
  invoice_no: f("string", ["InvoiceNo", "InvoiceNumber", "InvNo"]),
  cpt_code: f("string", ["CPTCode", "ActivityCode", "CptCode"]),
  quantity: f("number", ["Quantity", "Qty"]),
  claimed_amount: f("number", ["ClaimedAmount", "NetAmt", "NetAmount", "Net"]),
  paid_amount: f(
    "number",
    ["PaidAmount", "PaymentAmount", "PaidAmt", "RemittedAmt", "RemittedAmount", "Payment"],
    true,
  ),
  denied_amount: f("number", ["DeniedAmount", "RejectedAmt", "RejectedAmount", "DenialAmount"]),
  denial_code: f("string", ["DenialCode", "DenialReasonCode", "RejectionCode"]),
} as const satisfies Record<string, RemitField>;

export type RemitFieldName = keyof typeof REMITTANCE_FIELDS;
export const REMIT_FIELD_NAMES = Object.keys(REMITTANCE_FIELDS) as RemitFieldName[];

/** Recognised only to say "dropped N sensitive columns". Never parsed, stored or logged. */
export const REMITTANCE_SENSITIVE_HEADERS: readonly string[] = [
  ...DILIGENCE_SENSITIVE_HEADERS,
  "MemberName",
  "CardNumber",
  "PolicyNumber",
  "PatientShareComment",
  "Remarks",
  "Comment",
  "Comments",
];

export const REMITTANCE_SHEET_NAMES = ["Remittance", "RemittanceAdvice", "DataSheet"] as const;
export const MAX_REMITTANCE_ROWS = 30_000;
