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

// ---- XML remittance advice (Diligence / DHA e-claim portal "Remittance.Advice") ------------------------------------------
//
// Element names from the PUBLISHED DHA / Shafafiya remittance-advice schema, NOT verified against a real file (none is in
// the repo: it carries patient and member data). When the first real file arrives, correct the names here and nowhere
// else. Names are matched ignoring case. Anything not listed is never read; the ignored list is documentation and a test
// seeds those elements with values and checks none comes out.
export const REMITTANCE_XML = {
  root: "Remittance.Advice",
  claim: "Claim",
  activity: "Activity",
  /** Claim-level elements. The claim ID is the invoice number (the Unite invoice number = Diligence InvoiceNo). */
  claimFields: {
    invoice_no: "ID",
    payer_id: "IDPayer",
    remittance_ref: "PaymentReference",
    paid_on: "DateSettlement",
    denial_code: "DenialCode",
  },
  /** Activity-level elements. Activity/ID is deliberately not read: it is only a sequence within the claim. */
  activityFields: {
    cpt_code: "Code",
    quantity: "Quantity",
    claimed_amount: "Net",
    paid_amount: "PaymentAmount",
    denial_code: "DenialCode",
  },
  ignored: [
    "MemberID",
    "EmiratesIDNumber",
    "PatientID",
    "PatientName",
    "MemberName",
    "CardNumber",
    "PolicyNumber",
    "Clinician",
  ],
} as const;
export const MAX_REMITTANCE_XML_BYTES = 25 * 1024 * 1024;
