import type { PaymentEvent } from "@/lib/integrations/payments/types";

/**
 * What a gateway event does to a payment request (pure; the clock is a parameter).
 *
 * The rules that keep money honest:
 *   - a "paid" event whose amount or currency differs from the stored request is NEVER applied: the request is flagged for review
 *   - a payment that arrives after the link expired, was cancelled or had failed is still recorded as paid (the money exists)
 *     but flagged, so finance looks at it
 *   - paid is final: later events never change it
 *   - one declined attempt does not close the request (the payer can retry on the same link)
 */

export type PaymentStatus =
  "pending" | "created" | "sent" | "paid" | "failed" | "expired" | "cancelled";

export const OPEN_STATUSES: readonly PaymentStatus[] = ["pending", "created", "sent"];

export type RequestSnapshot = {
  status: PaymentStatus;
  amount_minor: number;
  currency: string;
  expires_at: string | null;
};

export type RequestPatch = {
  status?: PaymentStatus;
  needs_review?: boolean;
  review_reason?: string | null;
  failure_code?: string | null;
  amount_paid_minor?: number;
  paid_at?: string;
  last_event_at: string;
};

export type EventDecision =
  | { action: "ignore"; reason: string }
  | {
      action: "apply";
      reason: string;
      patch: RequestPatch;
      /** Statuses the row may be in for the update to be applied (the database does the compare-and-set). */
      from: PaymentStatus[];
      notify: "paid" | "failed" | "review" | null;
    };

/** A late payment is only "after expiry" once this much time has passed (the expiry sweep runs every 15 minutes). */
export const EXPIRY_GRACE_MS = 20 * 60_000;

export function decidePaymentEvent(
  req: RequestSnapshot,
  ev: PaymentEvent,
  nowMs: number,
): EventDecision {
  const at = new Date(nowMs).toISOString();
  if (ev.type === "ignored") return { action: "ignore", reason: "ignored_event" };

  if (ev.type === "paid") {
    if (ev.amountMinor === null || ev.currency === null) {
      return {
        action: "apply",
        reason: "amount_missing",
        patch: { needs_review: true, review_reason: "amount_missing", last_event_at: at },
        from: [...OPEN_STATUSES, "expired", "cancelled", "failed"],
        notify: "review",
      };
    }
    if (ev.amountMinor !== req.amount_minor || ev.currency.toUpperCase() !== req.currency) {
      return {
        action: "apply",
        reason: "amount_mismatch",
        patch: { needs_review: true, review_reason: "amount_mismatch", last_event_at: at },
        from: [...OPEN_STATUSES, "expired", "cancelled", "failed", "paid"],
        notify: "review",
      };
    }
    if (req.status === "paid") return { action: "ignore", reason: "already_paid" };
    let late: string | null = null;
    if (req.status === "expired" || req.status === "cancelled" || req.status === "failed")
      late = `paid_after_${req.status}`;
    else if (req.expires_at && nowMs > Date.parse(req.expires_at) + EXPIRY_GRACE_MS)
      late = "paid_after_expiry";
    return {
      action: "apply",
      reason: late ?? "paid",
      patch: {
        status: "paid",
        paid_at: at,
        amount_paid_minor: ev.amountMinor,
        failure_code: null,
        last_event_at: at,
        ...(late ? { needs_review: true, review_reason: late } : {}),
      },
      from: [...OPEN_STATUSES, "expired", "cancelled", "failed"],
      notify: late ? "review" : "paid",
    };
  }

  if (req.status === "paid") return { action: "ignore", reason: "already_paid" };

  if (ev.type === "declined") {
    if (!OPEN_STATUSES.includes(req.status)) return { action: "ignore", reason: "not_open" };
    return {
      action: "apply",
      reason: "declined",
      patch: { failure_code: ev.code?.slice(0, 60) ?? "declined", last_event_at: at },
      from: [...OPEN_STATUSES],
      notify: null,
    };
  }
  if (!OPEN_STATUSES.includes(req.status)) return { action: "ignore", reason: "not_open" };
  if (ev.type === "failed") {
    return {
      action: "apply",
      reason: "failed",
      patch: {
        status: "failed",
        failure_code: ev.code?.slice(0, 60) ?? "failed",
        last_event_at: at,
      },
      from: [...OPEN_STATUSES],
      notify: "failed",
    };
  }
  return {
    action: "apply",
    reason: "expired",
    patch: { status: "expired", last_event_at: at },
    from: [...OPEN_STATUSES],
    notify: null,
  };
}
