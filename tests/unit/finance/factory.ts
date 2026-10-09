/** Synthetic Unite-shaped records for tests. Fake names, PINs and numbers only. */

export type Raw = Record<string, unknown>;

/** JSON cannot carry undefined: a key set to undefined means "absent". */
const clean = (o: Raw): Raw =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export function rawLine(over: Raw = {}): Raw {
  return clean({
    ItemCode: "T-TEST-1",
    CPTCode: "99213",
    ItemShortDesc: "Test consultation",
    ItemType: "SERVICE",
    Qty: 1,
    Price: "100.00",
    GrossAmount: "100.00",
    DiscountAmount: "0",
    NetAmount: "100.00",
    VATApplicable: "N",
    VATAmount: "0",
    TotalAmount: "100.00",
    LineRemarks: "",
    ActualCostPrice: 0,
    ...over,
  });
}

export function rawPayment(over: Raw = {}): Raw {
  return clean({
    InstalmentNo: 1,
    PaymentMode: "CARD",
    Collected: "100.00",
    Paid: "100.00",
    PaidDate: "02-03-2026",
    Returned: "0",
    ReceiptNumber: "R-TEST-1",
    Refund: "0",
    CardType: "VISA",
    ...over,
  });
}

export function rawInvoice(over: Raw = {}): Raw {
  return clean({
    InvDisplayNumber: "ADMC/C/90001",
    RefType: "OP",
    TransactionDate: "02-03-2026",
    PatientPIN: "PIN-TEST-1",
    PatientName: "Test Patient One", // must never reach the normalised record
    EmiratesID: "000-0000-0000000-0",
    AppointmentId: "APPT-TEST-1",
    ClinicLongName: "Test Clinic One",
    ClinicShortName: "TC1",
    DoctorDHAId: "DHA-TEST-1",
    DoctorName: "Dr Test",
    Department: "General",
    Specialty: "GP",
    InvType: "SELF PAID",
    IsPackage: "N",
    IsDeleted: "N",
    GrossAmount: "100.00",
    DiscountAmount: "0",
    NetAmount: "100.00",
    VATApplicable: "N",
    VATAmount: "0",
    TotalAmount: "100.00",
    WriteOff: "0",
    CreditNote: "0",
    CreatedBy: "u1",
    ModifiedBy: "u1",
    ItemsDetails: [rawLine()],
    PaymentDetails: [rawPayment()],
    ...over,
  });
}
