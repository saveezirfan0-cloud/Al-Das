/**
 * The ONLY place that knows Unite's JSON key names.
 *
 * Unite has not yet delivered the field list (docs/finance/open-items.md), so
 * each logical field lists the key names it may arrive under. Matching ignores
 * case, spaces, underscores and dashes. When the field list arrives, edit the
 * aliases here and replay failed batches; nothing else changes.
 *
 * `required` fields must resolve for every record, otherwise the whole batch
 * fails closed (the raw payload is kept and can be replayed). Optional fields
 * resolve to null when absent.
 */

export type FieldSpec = { aliases: readonly string[]; required?: boolean };
export type FieldMap = Record<string, FieldSpec>;

export const INVOICE_FIELDS = {
  inv_display_number: { aliases: ["InvDisplayNumber", "InvoiceNumber", "InvNo"], required: true },
  ref_type: { aliases: ["RefType"] },
  transaction_date: {
    aliases: ["TransactionDate", "TxnDate", "InvDate", "InvoiceDate", "TransDate"],
    required: true,
  },
  patient_pin: { aliases: ["PatientPIN", "PIN", "PatientId", "PatientNo", "UHID"] },
  appointment_id: { aliases: ["AppointmentId", "AppointmentID"] },
  unite_clinic_long_name: { aliases: ["ClinicLongName"] },
  unite_bu_short_name: { aliases: ["BUShortName", "BusinessUnitShortName"] },
  doctor_dha_id: {
    aliases: ["DoctorDHAId", "DoctorDHAID", "DHAId", "DoctorId", "DoctorLicenseNo"],
  },
  doctor_name: { aliases: ["DoctorName"] },
  department: { aliases: ["Department", "DepartmentName", "Dept"] },
  specialty: { aliases: ["Specialty", "Speciality"] },
  inv_type: { aliases: ["InvType", "InvoiceType"] },
  is_package: { aliases: ["IsPackage"] },
  is_deleted: { aliases: ["IsDeleted"], required: true },
  gross: { aliases: ["GrossAmount", "Gross", "GrossAmt"], required: true },
  discount: { aliases: ["DiscountAmount", "Discount", "DiscAmt"] },
  net: { aliases: ["NetAmount", "Net", "NetAmt"], required: true },
  vat_applicable: { aliases: ["VATApplicable", "IsVATApplicable", "VatApplicable"] },
  vat: { aliases: ["VATAmount", "VAT", "VatAmt"] },
  total: { aliases: ["TotalAmount", "Total", "TotalAmt"], required: true },
  write_off: { aliases: ["WriteOff", "WriteOffAmount"] },
  credit_note: { aliases: ["CreditNote", "CreditNoteAmount"] },
  referral_doctor: { aliases: ["ReferralDoctor", "ReferralDoctorName"] },
  referral_doctor_id: { aliases: ["ReferralDoctorId", "ReferralDoctorDHAId"] },
  referral_clinic: { aliases: ["ReferralClinic", "ReferralClinicName"] },
  referral_clinic_id: { aliases: ["ReferralClinicId"] },
  created_by: { aliases: ["CreatedBy"] },
  modified_by: { aliases: ["ModifiedBy"] },
} as const satisfies FieldMap;

export const LINE_FIELDS = {
  item_code: { aliases: ["ItemCode"], required: true },
  cpt_code: { aliases: ["CPTCode", "CptCode"] },
  item_short_desc: {
    aliases: ["ItemShortDesc", "ItemShortDescription", "ItemDescription", "ItemName"],
  },
  item_type: { aliases: ["ItemType"] },
  qty: { aliases: ["Qty", "Quantity"] },
  line_price: { aliases: ["Price", "UnitPrice", "LinePrice", "ItemPrice"] },
  line_gross: { aliases: ["GrossAmount", "LineGross", "Gross"] },
  line_discount: { aliases: ["DiscountAmount", "LineDiscount", "Discount"] },
  line_net: { aliases: ["NetAmount", "LineNet", "Net"], required: true },
  vat_applicable: { aliases: ["VATApplicable", "IsVATApplicable", "VatApplicable"] },
  vat: { aliases: ["VATAmount", "VAT", "VatAmt"] },
  total: { aliases: ["TotalAmount", "Total", "LineTotal"] },
  line_remarks: { aliases: ["LineRemarks", "Remarks", "ItemRemarks"] },
  is_package_item: { aliases: ["IsPackageItem", "IsPackage"] },
  actual_cost_price: { aliases: ["ActualCostPrice"] },
} as const satisfies FieldMap;

export const PAYMENT_FIELDS = {
  instalment: { aliases: ["InstalmentNo", "InstallmentNo", "Instalment", "Installment"] },
  payment_mode: { aliases: ["PaymentMode"] },
  collected: { aliases: ["Collected", "CollectedAmount"] },
  paid: { aliases: ["Paid", "PaidAmount"] },
  paid_date: { aliases: ["PaidDate", "PaymentDate"] },
  returned: { aliases: ["Returned", "ReturnedAmount"] },
  receipt_number: { aliases: ["ReceiptNumber", "ReceiptNo"] },
  advance_added: { aliases: ["AdvanceAdded"] },
  refund: { aliases: ["Refund", "RefundAmount"] },
  refund_date: { aliases: ["RefundDate"] },
  txn_ref_no: { aliases: ["TxnRefNo", "TransactionRefNo"] },
  txn_ref_name: { aliases: ["TxnRefName", "TransactionRefName"] },
  card_type: { aliases: ["CardType"] },
  surcharge: { aliases: ["Surcharge", "SurchargeAmount"] },
  remarks: { aliases: ["Remarks", "PaymentRemarks"] },
} as const satisfies FieldMap;

/** A payment object must resolve at least one of these, or it is not recognisable as a payment. */
export const PAYMENT_ANCHORS = ["paid", "collected", "refund"] as const;

const squash = (s: string) => s.toLowerCase().replace(/[\s_-]/g, "");

/** Find the first alias present on the record. Returns { found, value }. */
export function pick(
  record: Record<string, unknown>,
  aliases: readonly string[],
): { found: boolean; value: unknown } {
  const keys = new Map<string, string>();
  for (const k of Object.keys(record)) keys.set(squash(k), k);
  for (const alias of aliases) {
    const real = keys.get(squash(alias));
    if (real !== undefined) return { found: true, value: record[real] };
  }
  return { found: false, value: undefined };
}
