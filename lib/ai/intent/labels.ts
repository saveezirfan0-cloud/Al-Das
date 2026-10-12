/** The five things an inbound message can be labelled. Tiny and dependency-free so screens can import it. */
export const INTENTS = ["booking", "price", "complaint", "report_request", "emergency"] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABELS: Record<Intent, string> = {
  booking: "Wants to book",
  price: "Asking about price",
  complaint: "Complaint",
  report_request: "Asking for a report",
  emergency: "Possible emergency",
};
