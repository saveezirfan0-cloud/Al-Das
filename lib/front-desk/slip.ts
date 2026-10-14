/**
 * The printed appointment slip and payment record (Phase E, pure).
 *
 * The slip is what the patient takes home: their FIRST name only, the time, the doctor, the branch and its address, and
 * the booking number. No service, notes, phone, date of birth or anything clinical. The payment record lists the
 * payments Pulse holds for the visit (the Unite finance mirror and paid online payment links) and says plainly that it is
 * not a tax invoice; tax invoices come from the billing system.
 */

export const RECEIPT_NOTICE =
  "Payment record from Pulse for your information. This is not a tax invoice.";

/** First name only (the slip is handed over and may be left lying around). */
export function slipFirstName(
  firstName: string | null | undefined,
  fullName?: string | null,
): string {
  const pick = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";
  return pick(firstName) || pick(fullName) || "Patient";
}

/** "Booking 1042": the number the desk and the patient quote. */
export function bookingNumber(n: number): string {
  return `Booking ${n}`;
}

export type SlipKind = "slip" | "receipt";

export function slipKind(v: unknown): SlipKind {
  return v === "receipt" ? "receipt" : "slip";
}

export type PaymentLine = {
  date: string | null;
  mode: string;
  amount: number;
  reference: string | null;
};

type MirrorPayment = {
  paid: number | null;
  refund: number | null;
  paid_date: string | null;
  payment_mode: string | null;
  receipt_number: string | null;
  is_current: boolean;
};

type OnlinePayment = {
  status: string;
  amount_paid_minor: number | null;
  amount_minor: number;
  paid_at: string | null;
  invoice_number: string;
};

/**
 * The lines of the payment record: current mirror payments with money in (refunds shown as negative lines) and paid
 * online payment links. Nothing else, and never an invoice total (that would read as a bill).
 */
export function paymentLines(
  mirror: readonly MirrorPayment[],
  online: readonly OnlinePayment[],
): {
  lines: PaymentLine[];
  total: number;
} {
  const lines: PaymentLine[] = [];
  for (const p of mirror) {
    if (!p.is_current) continue;
    if (p.paid && p.paid > 0)
      lines.push({
        date: p.paid_date,
        mode: p.payment_mode?.trim() || "Payment",
        amount: p.paid,
        reference: p.receipt_number,
      });
    if (p.refund && p.refund > 0)
      lines.push({
        date: p.paid_date,
        mode: "Refund",
        amount: -p.refund,
        reference: p.receipt_number,
      });
  }
  for (const o of online) {
    if (o.status !== "paid") continue;
    const minor = o.amount_paid_minor ?? o.amount_minor;
    lines.push({
      date: o.paid_at ? o.paid_at.slice(0, 10) : null,
      mode: "Online payment link",
      amount: minor / 100,
      reference: o.invoice_number,
    });
  }
  lines.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  const total = Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;
  return { lines, total };
}
