import type { FieldSpec } from "@/lib/finance/unite-mapping";

/**
 * The ONLY place that knows the Diligence "Claim Details with Activity" column names.
 *
 * No real export is in the repo (it contains patient names and Emirates IDs). The aliases cover the
 * names in the project brief and the clinic's real "ACTIVTY" export header row (Oct 2026, 70 columns,
 * see docs/finance/diligence-header-request.md); the upload screen lists every header it did not
 * recognise, so a later change is quick to fix.
 *
 * Columns are matched ignoring case, spaces, underscores and dashes. A column that is not listed
 * here is NEVER read or stored, so unknown columns (which may hold patient data) are dropped.
 */

export type DiligenceKind = "string" | "number" | "int" | "date" | "bool";
export type DiligenceField = FieldSpec & { kind: DiligenceKind };

const f = (kind: DiligenceKind, aliases: string[], required = false): DiligenceField => ({
  kind,
  aliases,
  required,
});

export const DILIGENCE_FIELDS = {
  claim_activity_number: f(
    "string",
    ["ClaimActivityNumber", "ClaimActivityNo", "ActivityNumber"],
    true,
  ),
  invoice_no: f("string", ["InvoiceNo", "InvoiceNumber", "InvNo"], true),
  transaction_date: f("date", ["TransactionDate", "ClaimDate"]),
  activity_start_date: f("date", ["ActivityStartDate", "ActivityDate", "ServiceDate"]),
  encounter_type: f("string", ["EncounterType"]),
  cpt_code: f("string", ["CPTCode", "ActivityCode", "CptCode"], true),
  cpt_category: f("string", ["CPTCategory"]),
  cpt_type: f("string", ["CPTType"]),
  quantity: f("number", ["Quantity", "Qty"]),
  ordering_clinician_id: f("string", ["OrderingClinician", "OrderingClinicianID"]),
  clinician_id: f("string", ["Clinician", "ClinicianID", "PerformingClinician"]),
  receiver_id: f("string", ["ReceiverID", "ReceiverId"]),
  payer_id: f("string", ["PayerID", "PayerId"]),
  prior_auth_id: f("string", ["PriorAuthID", "PriorAuthorizationID", "PriorAuthId"]),
  payment_reference: f("string", ["PaymentReference", "PaymentRef"]),
  initial_net: f("number", ["InitialNetAmt", "InitialNetAmount", "InitialNet"], true),
  net: f("number", ["NetAmt", "NetAmount", "Net"], true),
  remitted: f("number", ["RemittedAmt", "RemittedAmount", "Remitted"], true),
  last_remitted: f("number", ["LastRemittedAmt", "LastRemittedAmount"]),
  initial_rejected: f("number", ["InitialRejectedAmt", "InitialRejectedAmount"]),
  rejected: f("number", ["RejectedAmt", "RejectedAmount", "Rejected"], true),
  unprocessed: f("number", ["UnprocessedAmt", "UnprocessedAmount"]),
  write_off: f("number", ["WriteOffAmt", "WriteOffAmount", "WriteOff"]),
  write_off_status: f("string", ["WriteOffStatus"]),
  settled: f("bool", ["Settled", "IsSettled"]),
  principal_diagnosis: f("string", [
    "PrincipalDiagnosis",
    "PrincipalDiagnosisCode",
    "PrimaryDiagnosis",
  ]),
  diagnosis_text: f("string", ["DiagnosisText", "DiagnosisDescription"]),
  // Diligence spells this header "LastDenailCode"; without the alias no denial case is ever opened.
  last_denial_code: f("string", ["LastDenialCode", "LastDenailCode"]),
  denial_category: f("string", ["DenialCategory"]),
  denial_type: f("string", ["DenialType"]),
  denial_comment: f("string", ["DenialComment"]),
  initial_denial_code: f("string", ["InitialDenialCode"]),
  initial_denial_type: f("string", ["InitialDenialType"]),
  resubmission_count: f("int", ["ResubmissionCount", "ResubmissionsCount"]),
  remittance_count: f("int", ["RemittanceCount", "RemittancesCount"]),
  first_remittance_date: f("date", ["FirstRemittanceDate"]),
  last_remittance_date: f("date", ["LastRemittanceDate"]),
  last_resubmission_date: f("date", ["LastResubmissionDate"]),
  claim_status: f("string", ["ClaimStatus"], true),
  payment_status: f("string", ["PaymentStatus"]),
  receipt_status: f("string", ["ReceiptStatus"]),
  claim_year: f("int", ["ClaimYear"]),
  claim_month: f("int", ["ClaimMonth"]),
} as const satisfies Record<string, DiligenceField>;

export type DiligenceFieldName = keyof typeof DILIGENCE_FIELDS;
export const DILIGENCE_FIELD_NAMES = Object.keys(DILIGENCE_FIELDS) as DiligenceFieldName[];

/**
 * Columns that are recognised only so the upload screen can say "dropped N sensitive columns".
 * They are never parsed, stored or logged. (MemberID, Emirates ID, patient identity, free-text
 * comments from the payer.)
 */
export const DILIGENCE_SENSITIVE_HEADERS: readonly string[] = [
  "EmiratesIDNumber",
  "EmiratesID",
  "MemberID",
  "MemberId",
  "ResubmissionComment",
  "RemittanceComment",
  "PatientName",
  "PatientFullName",
  "DateOfBirth",
  "DOB",
  "PatientMobile",
  "PatientPhone",
  // seen in the real export: patient and payer member ids, clinician names, free-text comments
  "PatientID",
  "IDPayer",
  "OrderingClinician_Name",
  "Clinician_Name",
  "WriteOffComment",
  "InitialDenialComment",
];

/**
 * The insurer's display name. Read only to fill a blank `fin_ref_payers.payer_name` for the payer id
 * on the same row (an insurer's name is business data); never stored on the claim line.
 */
export const DILIGENCE_PAYER_NAME_HEADERS: readonly string[] = ["Payer_Name", "PayerName"];

export const DILIGENCE_SHEET_NAMES = ["DataSheet"] as const;
