/**
 * Natural keys for finance rows. Pure functions, shared by the capture job,
 * the Diligence matcher and tests. These must stay in step with the generated
 * `fin_invoices.inv_key` column (upper-cased, whitespace removed).
 */

/** Normalise an invoice number for matching: case and whitespace insensitive. */
export function normalizeInvoiceNumber(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * Unite has no invoice line id, so a line is identified by
 * `<inv_display_number>|<item_code>|<occurrence>` where occurrence is the
 * 1-based count of earlier lines with the same item code on the invoice.
 */
export function lineKey(invDisplayNumber: string, itemCode: string, occurrence: number): string {
  if (!Number.isInteger(occurrence) || occurrence < 1)
    throw new RangeError("occurrence must be a positive integer");
  return `${invDisplayNumber}|${itemCode}|${occurrence}`;
}

/** Keys for a whole invoice's lines, in delivery order. */
export function lineKeys(invDisplayNumber: string, itemCodes: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return itemCodes.map((code) => {
    const n = (seen.get(code) ?? 0) + 1;
    seen.set(code, n);
    return lineKey(invDisplayNumber, code, n);
  });
}

/** `<inv_display_number>|<instalment>|<receipt_number>`; blank parts stay blank so the key is stable. */
export function paymentKey(
  invDisplayNumber: string,
  instalment: string | number | null | undefined,
  receiptNumber: string | null | undefined,
): string {
  return `${invDisplayNumber}|${instalment ?? ""}|${receiptNumber ?? ""}`;
}
