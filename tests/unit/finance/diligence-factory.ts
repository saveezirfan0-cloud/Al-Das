/** Synthetic Diligence tables for tests. Fake ids and amounts only. */
import { DILIGENCE_FIELDS, type DiligenceFieldName } from "@/lib/finance/diligence-mapping";

const primary = (n: DiligenceFieldName) => DILIGENCE_FIELDS[n].aliases[0];

export const BASE_ROW: Record<string, unknown> = {
  ClaimActivityNumber: "CA-TEST-1",
  InvoiceNo: "ADMC/C/90001",
  TransactionDate: "02-03-2026",
  ActivityStartDate: "02-03-2026",
  EncounterType: "OP",
  CPTCode: "99213",
  CPTCategory: "E&M",
  CPTType: "CPT",
  Quantity: 1,
  OrderingClinician: "DHA-TEST-1",
  Clinician: "DHA-TEST-1",
  ReceiverID: "RCV-TEST",
  PayerID: "PAYER-TEST",
  PriorAuthID: "",
  PaymentReference: "",
  InitialNetAmt: 100,
  NetAmt: 100,
  RemittedAmt: 60,
  LastRemittedAmt: 60,
  InitialRejectedAmt: 40,
  RejectedAmt: 40,
  UnprocessedAmt: 0,
  WriteOffAmt: 0,
  WriteOffStatus: "",
  Settled: "N",
  PrincipalDiagnosis: "Z00.0",
  DiagnosisText: "Test diagnosis",
  LastDenialCode: "MNEC-003",
  DenialCategory: "Clinical",
  DenialType: "Medical necessity",
  DenialComment: "Test comment",
  InitialDenialCode: "MNEC-003",
  InitialDenialType: "Medical necessity",
  ResubmissionCount: 0,
  RemittanceCount: 1,
  FirstRemittanceDate: "20-03-2026",
  LastRemittanceDate: "20-03-2026",
  LastResubmissionDate: "",
  ClaimStatus: "Partially Paid",
  PaymentStatus: "Partial",
  ReceiptStatus: "Received",
  ClaimYear: 2026,
  ClaimMonth: 3,
  // never imported:
  EmiratesIDNumber: "000-0000-0000000-0",
  MemberID: "MEMBER-TEST",
  ResubmissionComment: "patient said something",
  RemittanceComment: "payer note",
  PatientName: "Test Patient One",
  SomeUnknownColumn: "unknown",
};

export function table(
  rows: Array<Record<string, unknown>> = [BASE_ROW],
  drop: string[] = [],
): unknown[][] {
  const headers = Object.keys(BASE_ROW).filter((h) => !drop.includes(h));
  return [headers, ...rows.map((r) => headers.map((h) => (h in r ? r[h] : BASE_ROW[h])))];
}

export const row = (over: Record<string, unknown> = {}) => ({ ...BASE_ROW, ...over });
export { primary };
