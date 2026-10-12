import "server-only";

import { decidePaymentEvent, type RequestSnapshot } from "@/lib/integrations/payments/state";
import type { PaymentEvent } from "@/lib/integrations/payments/types";
import { notifyMembersWithPermission } from "@/lib/notifications";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Records what a payment gateway reported on the matching fin_payment_requests row, and tells finance. This is the ONLY writer of
 * payment status from outside, and it writes nothing else: no invoice, no claim, nothing in Unite. The decision is pure
 * (state.ts); the update is a compare-and-set on the current status so two deliveries racing each other cannot both win.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TEXT = {
  paid: {
    title: "A payment link was paid",
    body: "Open Finance, Payment links to reconcile it. Pulse does not mark the invoice as paid in Unite.",
  },
  review: {
    title: "A payment link needs review",
    body: "The payment gateway reported a payment that does not match the request, or that arrived late. Open Finance, Payment links.",
  },
  failed: {
    title: "A payment link failed",
    body: "The payment gateway reported that a payment link can no longer be paid. Open Finance, Payment links.",
  },
} as const;

export async function applyPaymentEvent(
  admin: AdminClient,
  a: { orgId: string; provider: "stripe" | "paytabs"; event: PaymentEvent; now?: Date },
): Promise<string> {
  const { event } = a;
  const nowMs = (a.now ?? new Date()).getTime();

  const cols = "id, status, amount_minor, currency, expires_at, provider_ref";
  let req: {
    id: string;
    status: string;
    amount_minor: number;
    currency: string;
    expires_at: string | null;
    provider_ref: string | null;
  } | null = null;
  if (event.providerRef) {
    const { data } = await admin
      .from("fin_payment_requests")
      .select(cols)
      .eq("org_id", a.orgId)
      .eq("provider", a.provider)
      .eq("provider_ref", event.providerRef)
      .maybeSingle();
    req = data;
  }
  if (!req && event.requestId && UUID.test(event.requestId)) {
    const { data } = await admin
      .from("fin_payment_requests")
      .select(cols)
      .eq("org_id", a.orgId)
      .eq("provider", a.provider)
      .eq("id", event.requestId)
      .maybeSingle();
    req = data;
  }
  if (!req) return "unknown_request";

  const decision = decidePaymentEvent(
    {
      status: req.status as RequestSnapshot["status"],
      amount_minor: Number(req.amount_minor),
      currency: req.currency,
      expires_at: req.expires_at,
    },
    event,
    nowMs,
  );
  if (decision.action === "ignore") return `ignored_${decision.reason}`;

  const { data: updated } = await admin
    .from("fin_payment_requests")
    .update(decision.patch)
    .eq("id", req.id)
    .eq("org_id", a.orgId)
    .in("status", decision.from)
    .select("id");
  if (!updated?.length) return "not_applied";

  if (!req.provider_ref && event.providerRef) {
    await admin
      .from("fin_payment_requests")
      .update({ provider_ref: event.providerRef })
      .eq("id", req.id)
      .eq("org_id", a.orgId)
      .is("provider_ref", null);
  }
  if (decision.notify) {
    const t = TEXT[decision.notify];
    await notifyMembersWithPermission(admin, a.orgId, "finance.payment_links", {
      type: "finance.payment_link",
      title: t.title,
      body: t.body,
      payload: { request_id: req.id },
    });
  }
  return `applied_${decision.reason}`;
}
