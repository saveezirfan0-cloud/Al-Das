"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { loadAccount, readConfig } from "@/lib/integrations/accounts";
import { minorToMajor } from "@/lib/integrations/payments/money";
import { readPaymentsConfig } from "@/lib/integrations/payments/config";
import {
  cancelPaymentRequest,
  createPaymentRequest,
  lookupInvoice,
} from "@/lib/integrations/payments/request-server";
import { checkRateLimit, RATE_RULES, waitText } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Payment links for finance invoices. Everything here needs finance.payment_links (nothing else opens it, not even finance.view),
 * and each send is an explicit staff action. The integration is OFF until an administrator switches it on and types the
 * confirmation (Settings, Integrations). Nothing is written to Unite and no invoice is marked paid.
 */

export type LookupResult =
  | {
      ok: true;
      number: string;
      currency: string;
      total: string | null;
      hasPatient: boolean;
      hasLiveRequest: boolean;
    }
  | { ok: false; error: string };

export type SendResult = { ok: true; message: string } | { ok: false; error: string };

const numberSchema = z.string().trim().min(1).max(60);

export async function lookupPaymentInvoice(invoiceNumber: string): Promise<LookupResult> {
  const member = await requirePerm("finance.payment_links");
  const p = numberSchema.safeParse(invoiceNumber);
  if (!p.success) return { ok: false, error: "Enter an invoice number." };
  const admin = createAdminClient();
  const account = await loadAccount(admin, member.orgId, "payments");
  const currency = readPaymentsConfig(readConfig(account)).currency;
  const inv = await lookupInvoice(admin, member.orgId, p.data, currency);
  if (!inv) return { ok: false, error: "No invoice with that number." };
  return {
    ok: true,
    number: inv.number,
    currency,
    total: inv.totalMinor === null ? null : minorToMajor(inv.totalMinor, currency),
    hasPatient: !!inv.patientPin,
    hasLiveRequest: inv.hasLiveRequest,
  };
}

const sendSchema = z.object({
  invoiceNumber: numberSchema,
  amount: z.string().trim().min(1).max(20),
});

export async function sendPaymentLink(input: z.input<typeof sendSchema>): Promise<SendResult> {
  const member = await requirePerm("finance.payment_links");
  const p = sendSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Enter the invoice number and the amount." };
  const admin = createAdminClient(member.userId);
  const limit = await checkRateLimit(
    admin,
    "payment-link",
    member.userId,
    RATE_RULES.paymentLinkPerUser,
  );
  if (!limit.allowed)
    return { ok: false, error: `Too many requests. Try again in ${waitText(limit.retryAfter)}.` };
  const r = await createPaymentRequest(admin, {
    orgId: member.orgId,
    actorId: member.userId,
    invoiceNumber: p.data.invoiceNumber,
    amount: p.data.amount,
  });
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.payment_link_sent",
    entity: "fin_payment_request",
    entityId: r.requestId,
  });
  revalidatePath("/finance/payment-links");
  return { ok: true, message: "Payment link sent to the patient on WhatsApp." };
}

const cancelSchema = z.object({ id: z.string().uuid() });

export async function cancelPaymentLink(input: z.input<typeof cancelSchema>): Promise<SendResult> {
  const member = await requirePerm("finance.payment_links");
  const p = cancelSchema.safeParse(input);
  if (!p.success) return { ok: false, error: "Invalid request." };
  const admin = createAdminClient(member.userId);
  const r = await cancelPaymentRequest(admin, { orgId: member.orgId, requestId: p.data.id });
  if (!r.ok) return r;
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "finance.payment_link_cancelled",
    entity: "fin_payment_request",
    entityId: p.data.id,
    diff: { closed_at_gateway: r.closedAtGateway },
  });
  revalidatePath("/finance/payment-links");
  return {
    ok: true,
    message: r.closedAtGateway
      ? "Cancelled and closed at the payment gateway."
      : "Cancelled in Pulse. This gateway cannot close the link itself; if the patient still pays, it will be flagged for review.",
  };
}
