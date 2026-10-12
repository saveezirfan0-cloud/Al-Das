/**
 * Demo finance records: Unite-shaped invoices built with the synthetic builders in tests/unit/finance/factory.ts
 * (fake PINs, fake clinic names, made-up amounts), wrapped in the response envelope the fixture file uses. They are
 * stored as a raw batch and processed by the normal mapper, exactly like a captured batch, so the Finance pages
 * have invoices, lines and payments to show. Unite itself is never called.
 */
import { rawInvoice, rawLine, rawPayment, type Raw } from "../../tests/unit/finance/factory";

const pad = (n: number) => String(n).padStart(2, "0");
/** Unite writes dates day-first. */
const dmy = (d: Date) => `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;

export function demoFinanceBatch(now: Date): Raw {
  const doctors = [
    { name: "Dr Alpha Demo", dha: "DHA-DEMO-1", dept: "General practice" },
    { name: "Dr Charlie Demo", dha: "DHA-DEMO-3", dept: "Dentistry" },
    { name: "Dr Delta Demo", dha: "DHA-DEMO-4", dept: "Dermatology" },
  ];
  const invoices: Raw[] = [];
  for (let i = 0; i < 9; i++) {
    const doc = doctors[i % doctors.length];
    const day = new Date(now.getTime() - (i + 1) * 3 * 24 * 3_600_000);
    const amount = 150 + (i % 4) * 100;
    const insured = i % 3 === 1;
    invoices.push(
      rawInvoice({
        InvDisplayNumber: `DEMO/C/${String(1000 + i)}`,
        TransactionDate: dmy(day),
        PatientPIN: `DEMO-PIN-${String(100 + i)}`,
        PatientName: undefined,
        EmiratesID: undefined,
        AppointmentId: `DEMO-APPT-${String(100 + i)}`,
        ClinicLongName: "Demo Clinic Main",
        ClinicShortName: "DCM",
        DoctorDHAId: doc.dha,
        DoctorName: doc.name,
        Department: doc.dept,
        Specialty: doc.dept,
        InvType: insured ? "INSURANCE" : "SELF PAID",
        GrossAmount: amount.toFixed(2),
        NetAmount: amount.toFixed(2),
        TotalAmount: amount.toFixed(2),
        ItemsDetails: [
          rawLine({
            ItemCode: `DEMO-ITEM-${(i % 3) + 1}`,
            ItemShortDesc: "Demo consultation",
            Price: amount.toFixed(2),
            GrossAmount: amount.toFixed(2),
            NetAmount: amount.toFixed(2),
            TotalAmount: amount.toFixed(2),
          }),
        ],
        PaymentDetails: insured
          ? []
          : [
              rawPayment({
                Collected: amount.toFixed(2),
                Paid: amount.toFixed(2),
                PaidDate: dmy(day),
                ReceiptNumber: `DEMO-R-${1000 + i}`,
              }),
            ],
      }),
    );
  }
  return {
    MessageStatus: "Success",
    DetailMessage: "Demo data - fake names and PINs only",
    DataBalancetoSync: 0,
    OverallDataBalancetoSync: 0,
    Data: invoices,
  };
}
