/** Why an insurer payment is closed without being paid in full (fin_item_closures.reason_code). Pure labels. */
export const CLOSE_REASONS = {
  insurer_short_paid: "The insurer paid less than invoiced and will not pay more",
  insurer_rejected: "The insurer rejected the payment",
  duplicate_entry: "Entered twice",
  entered_in_error: "Entered in error",
  other: "Other (explain)",
} as const;
export type CloseReason = keyof typeof CLOSE_REASONS;
export const CLOSE_REASON_CODES = Object.keys(CLOSE_REASONS) as [CloseReason, ...CloseReason[]];

/** An item reference as the database stores it (fin_match_decisions.item_ref). */
export const ITEM_REF_PATTERN = /^ins\|[A-Za-z0-9:_-]{1,90}$/;
