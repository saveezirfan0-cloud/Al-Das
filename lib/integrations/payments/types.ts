/**
 * The provider seam for payment links (Phase 19). Pulse asks a `PaymentProvider` for a link and receives `PaymentEvent`s from the
 * provider's webhook; the vendor's field names stay inside the adapter (stripe.ts, paytabs.ts). Nothing in this seam carries a
 * patient name: a payment is described by our request id and the invoice number only.
 */

export type CreatePaymentInput = {
  /** fin_payment_requests.id: the idempotency key and the reference the webhook echoes back. */
  requestId: string;
  amountMinor: number;
  currency: string;
  /** Shown to the payer, e.g. "Invoice INV-1042". No names. */
  description: string;
  expiresAt: Date;
  returnUrl: string;
  webhookUrl: string;
};

export type CreatePaymentResult =
  | { ok: true; ref: string; url: string; expiresAt: Date | null }
  | { ok: false; code: string; retryable: boolean; ambiguous: boolean };

export interface PaymentProvider {
  readonly id: "stripe" | "paytabs";
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  /** Stop the link accepting payment. Not every gateway supports it; returns whether the gateway confirmed. */
  expire?(ref: string): Promise<boolean>;
  /** A read-only call that proves the credentials work (not every gateway has one). */
  verify?(): Promise<{ ok: boolean; code?: string }>;
}

/**
 * What a gateway webhook said, normalised.
 *   paid      money was captured
 *   failed    the payment can no longer succeed (terminal)
 *   declined  one attempt was declined; the payer may try again on the same link (the request stays open)
 *   expired   the link timed out
 *   ignored   informational (refunds and everything else are out of scope)
 */
export type PaymentEventType = "paid" | "failed" | "declined" | "expired" | "ignored";

export type PaymentEvent = {
  /** Stable per delivery of one fact: used for idempotency. */
  key: string;
  type: PaymentEventType;
  providerRef: string | null;
  /** Our request id, when the gateway echoes it back. */
  requestId: string | null;
  amountMinor: number | null;
  currency: string | null;
  code: string | null;
};
