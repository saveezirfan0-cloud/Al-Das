import "server-only";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import { serverEnv } from "@/lib/env";
import { resolveRecipient, type HouseholdContact } from "@/lib/household/addressing";
import { loadHouseholdLink } from "@/lib/household/server";
import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import {
  bumpUsage,
  loadAccount,
  readConfig,
  recordFailure,
  recordOk,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { formatMoney, majorToMinor } from "@/lib/integrations/payments/money";
import {
  paymentReturnUrl,
  paymentWebhookBase,
  readPaymentsConfig,
  type PaymentsConfig,
} from "@/lib/integrations/payments/config";
import {
  paymentValues,
  PROBE_CONTEXT,
  type PaymentValueContext,
} from "@/lib/integrations/payments/message";
import { buildPaymentProvider } from "@/lib/integrations/payments/provider";
import type { PaymentProvider } from "@/lib/integrations/payments/types";
import type { TemplateReadiness } from "@/lib/integrations/readiness";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

/**
 * Payment requests: create a gateway link for a finance invoice and send it to the patient as an approved WhatsApp template.
 *
 * Guards, in order: integration on -> not a training workspace -> credentials -> template approved, UTILITY and fully mapped ->
 * invoice exists and has a patient -> recipient (guardian-aware) has a WhatsApp identifier -> amount within the invoice total ->
 * one live request per invoice -> gateway -> queue. Nothing is written to Unite and the invoice is never marked paid.
 * Logs and errors carry ids and codes only: no amount, link, name or number.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

type TemplateRow = {
  id: string;
  name: string;
  status: string;
  category: string;
  components: unknown;
  channel_id: string | null;
  waba_id: string | null;
};

export async function loadPaymentTemplate(
  admin: AdminClient,
  orgId: string,
  id: string | null,
): Promise<TemplateRow | null> {
  if (!id) return null;
  const { data } = await admin
    .from("wa_templates")
    .select("id, name, status, category, components, channel_id, waba_id")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  return data;
}

/** How the chosen template looks to the readiness check (shared by the settings page and the send path). */
export function templateReadiness(
  template: TemplateRow | null,
  cfg: PaymentsConfig,
): TemplateReadiness | null {
  if (!template) return null;
  const probe = paymentValues(
    template.components as MetaTemplateComponent[],
    cfg.variableMap,
    PROBE_CONTEXT,
  );
  return {
    status: template.status,
    category: template.category,
    mappedAll: probe.missing.length === 0,
    hasLinkVariable: probe.hasLink,
    unsupported: probe.unsupported.length > 0,
  };
}

export type PaymentSetup = {
  account: AccountRow;
  cfg: PaymentsConfig;
  provider: PaymentProvider;
  template: TemplateRow;
};

export async function loadPaymentSetup(
  admin: AdminClient,
  orgId: string,
  deps: { provider?: PaymentProvider } = {},
): Promise<Result<{ setup: PaymentSetup }>> {
  const account = await loadAccount(admin, orgId, "payments");
  if (!account?.enabled)
    return {
      ok: false,
      error:
        "Payment links are switched off. An administrator can turn them on in Settings, Integrations.",
    };
  if (await isTrainingOrg(admin, orgId)) {
    await bumpUsage(admin, orgId, "payments", "blocked_training");
    return {
      ok: false,
      error: "This is a training workspace: payment links are never created here.",
    };
  }
  const cfg = readPaymentsConfig(readConfig(account));
  const provider = deps.provider ?? buildPaymentProvider(admin, account);
  if (!provider) return { ok: false, error: "The payment gateway credentials are incomplete." };
  const template = await loadPaymentTemplate(admin, orgId, cfg.templateId);
  const r = templateReadiness(template, cfg);
  if (
    !template ||
    !r ||
    r.status !== "APPROVED" ||
    r.category !== "UTILITY" ||
    !r.mappedAll ||
    !r.hasLinkVariable ||
    r.unsupported
  )
    return {
      ok: false,
      error:
        "The WhatsApp template for payment messages is not ready. Check Settings, Integrations, Payment links.",
    };
  return { ok: true, setup: { account, cfg, provider, template } };
}

export type InvoiceLookup = {
  id: string;
  number: string;
  patientPin: string | null;
  totalMinor: number | null;
  hasLiveRequest: boolean;
};

const normaliseInvoiceNumber = (s: string) => s.replace(/\s+/g, "").toUpperCase();

export async function lookupInvoice(
  admin: AdminClient,
  orgId: string,
  number: string,
  currency: string,
): Promise<InvoiceLookup | null> {
  const key = normaliseInvoiceNumber(number);
  if (!key || key.length > 60) return null;
  const { data: inv } = await admin
    .from("fin_invoices")
    .select("id, inv_display_number, patient_pin, total, is_deleted")
    .eq("org_id", orgId)
    .eq("inv_key", key)
    .maybeSingle();
  if (!inv || inv.is_deleted) return null;
  const { data: live } = await admin
    .from("fin_payment_requests")
    .select("id")
    .eq("org_id", orgId)
    .eq("invoice_id", inv.id)
    .in("status", ["pending", "created", "sent"])
    .limit(1);
  return {
    id: inv.id,
    number: inv.inv_display_number,
    patientPin: inv.patient_pin,
    totalMinor: inv.total === null ? null : majorToMinor(String(inv.total), currency),
    hasLiveRequest: !!live?.length,
  };
}

async function pickChannel(
  admin: AdminClient,
  orgId: string,
  template: TemplateRow,
): Promise<string | null> {
  const { data: channels } = await admin
    .from("channels")
    .select("id, waba_id")
    .eq("org_id", orgId)
    .eq("type", "whatsapp")
    .eq("status", "active");
  const ids = (channels ?? [])
    .filter((c) => !template.waba_id || c.waba_id === template.waba_id)
    .map((c) => c.id);
  return template.channel_id && ids.includes(template.channel_id)
    ? template.channel_id
    : (ids[0] ?? null);
}

export type CreateRequestInput = {
  orgId: string;
  /** The staff member who asked; null when a flow's Payment link step asked (Phase 20b). */
  actorId: string | null;
  /** A flow step may only send a link for an invoice of the run's own patient (or a dependant they are guardian of). */
  expectContactId?: string | null;
  invoiceNumber: string;
  /** Plain decimal in the integration's currency, e.g. "150.00". */
  amount: string;
  now?: Date;
  provider?: PaymentProvider;
  /**
   * A flow's Payment link step (flowStepKey: run id + step seq). The request row and its message both carry it (unique
   * columns), so a step replayed after a crash gets the request it already made back instead of a second link or message.
   */
  flowStepKey?: string;
};

/** failure_code of a request whose gateway call may or may not have made a link: never created again by code. */
const AMBIGUOUS_CREATE = "ambiguous_create";

export async function createPaymentRequest(
  admin: AdminClient,
  input: CreateRequestInput,
): Promise<Result<{ requestId: string; expiresAt: string }>> {
  const now = input.now ?? new Date();
  const replay = input.flowStepKey
    ? await flowStepRequest(admin, input.orgId, input.flowStepKey)
    : null;
  if (replay?.kind === "done") return { ok: true, ...replay.result };
  if (replay?.kind === "refuse") return { ok: false, error: replay.error };
  const setupRes = await loadPaymentSetup(admin, input.orgId, { provider: input.provider });
  if (!setupRes.ok) return setupRes;
  const { account, cfg, provider, template } = setupRes.setup;
  if (replay?.kind === "restart") {
    // The earlier attempt of this step never queued its message, so nothing reached the patient, and either never asked
    // the gateway ('pending') or holds a link the gateway confirmed ('created'): close it (and that link, through the
    // gateway the row was made with), release the key and start over.
    const old = replay.request;
    if (old.provider_ref && old.provider !== provider.id)
      return {
        ok: false,
        error:
          "An earlier attempt of this step made a link with another payment gateway; cancel it under Finance before trying again.",
      };
    const closed = await closeUnsentFlowStepRequest(admin, input.orgId, old);
    if (!closed) throw new Error("The payment request changed while the step was replayed");
    if (old.provider_ref && provider.expire) await provider.expire(old.provider_ref);
  }

  const amountMinor = majorToMinor(input.amount, cfg.currency);
  if (amountMinor === null)
    return { ok: false, error: "Enter the amount as a plain number, for example 150.00." };
  const invoice = await lookupInvoice(admin, input.orgId, input.invoiceNumber, cfg.currency);
  if (!invoice) return { ok: false, error: "No invoice with that number." };
  if (invoice.totalMinor !== null && amountMinor > invoice.totalMinor)
    return { ok: false, error: "The amount is more than the invoice total." };
  if (!invoice.patientPin)
    return {
      ok: false,
      error: "This invoice has no patient on it, so there is nobody to send the link to.",
    };
  if (invoice.hasLiveRequest)
    return {
      ok: false,
      error:
        "A payment link is already open for this invoice. Cancel it first if you need a new one.",
    };

  // The person who receives it: the patient, or the guardian of a dependant without a phone (the household rule).
  const { data: patient } = await admin
    .from("contacts")
    .select("id, first_name, last_name, phone_e164, wa_bsuid, stop_marketing")
    .eq("org_id", input.orgId)
    .eq("external_id", invoice.patientPin)
    .is("deleted_at", null)
    .is("merged_into_id", null)
    .is("erased_at", null)
    .limit(1)
    .maybeSingle();
  if (!patient) return { ok: false, error: "The patient on this invoice is not in Pulse yet." };
  const target = resolveRecipient(
    patient as HouseholdContact,
    await loadHouseholdLink(admin, input.orgId, patient.id),
  );
  if (!target) return { ok: false, error: "The patient has no WhatsApp number on file." };
  if (
    input.expectContactId &&
    patient.id !== input.expectContactId &&
    target.recipient.id !== input.expectContactId
  )
    return { ok: false, error: "That invoice belongs to another patient." };
  const channelId = await pickChannel(admin, input.orgId, template);
  if (!channelId) return { ok: false, error: "No active WhatsApp number can send this template." };

  const expiresAt = new Date(now.getTime() + cfg.expiryHours * 3_600_000);
  const { data: row, error: insertError } = await admin
    .from("fin_payment_requests")
    .insert({
      org_id: input.orgId,
      invoice_id: invoice.id,
      invoice_number: invoice.number,
      patient_pin: invoice.patientPin,
      contact_id: target.recipient.id,
      provider: cfg.provider,
      amount_minor: amountMinor,
      currency: cfg.currency,
      status: "pending",
      expires_at: expiresAt.toISOString(),
      created_by: input.actorId,
      flow_step_key: input.flowStepKey ?? null,
    })
    .select("id")
    .single();
  if (insertError || !row) {
    // The one-live-request-per-invoice index: a second click in the same moment.
    return {
      ok: false,
      error:
        insertError?.code === "23505"
          ? "A payment link is already open for this invoice."
          : "Could not create the payment request.",
    };
  }
  const requestId = row.id;
  const fail = async (code: string, error: string): Promise<{ ok: false; error: string }> => {
    await admin
      .from("fin_payment_requests")
      .update({ status: "failed", failure_code: code.slice(0, 60) })
      .eq("id", requestId)
      .eq("org_id", input.orgId);
    return { ok: false, error };
  };

  // Stamped before the gateway call: a replay after a crash from here on cannot know whether the gateway made a link, so
  // it never asks again (an ambiguous create is never sent twice by code).
  const stamped = await admin
    .from("fin_payment_requests")
    .update({ create_attempted_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("org_id", input.orgId);
  if (stamped.error)
    return fail("not_stamped", "Could not create the payment request. Nothing was sent.");

  const server = serverEnv();
  const created = await provider.createPayment({
    requestId,
    amountMinor,
    currency: cfg.currency,
    description: `Invoice ${invoice.number}`.slice(0, 120),
    expiresAt,
    returnUrl: paymentReturnUrl(server.APP_URL, cfg.returnUrl),
    webhookUrl: paymentWebhookBase(server.APP_URL, account.id),
  });
  if (!created.ok) {
    await recordFailure(admin, input.orgId, "payments", `gateway error ${created.code}`);
    await bumpUsage(admin, input.orgId, "payments", "create_failed");
    if (created.ambiguous)
      return fail(
        AMBIGUOUS_CREATE,
        "The payment gateway did not answer clearly, so the link may exist there. Nothing was sent to the patient; check the gateway before trying again.",
      );
    return fail(
      created.code,
      "The payment gateway did not create the link. Nothing was sent to the patient.",
    );
  }
  await recordOk(admin, input.orgId, "payments");
  const finalExpiry =
    created.expiresAt && created.expiresAt < expiresAt ? created.expiresAt : expiresAt;
  const stored = await admin
    .from("fin_payment_requests")
    .update({
      provider_ref: created.ref.slice(0, 120),
      status: "created",
      expires_at: finalExpiry.toISOString(),
    })
    .eq("id", requestId)
    .eq("org_id", input.orgId);
  if (stored.error) {
    // Without the gateway reference a later webhook could not be matched: close the link instead of sending it.
    if (provider.expire) await provider.expire(created.ref);
    return fail(
      "reference_not_stored",
      "The payment link could not be recorded, so it was closed. Try again.",
    );
  }

  // The message: approved template only (it is also what makes the 24-hour rule irrelevant), to the resolved recipient.
  const { data: org } = await admin
    .from("orgs")
    .select("name, timezone")
    .eq("id", input.orgId)
    .single();
  const first = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";
  const ctx: PaymentValueContext = {
    first_name: first(target.recipient.first_name) || "there",
    patient_first_name: first(patient.first_name),
    amount_due: formatMoney(amountMinor, cfg.currency),
    invoice_ref: invoice.number,
    clinic_name: org?.name ?? "",
    payment_link: created.url,
    expires_on: new Intl.DateTimeFormat("en-GB", {
      timeZone: org?.timezone ?? "Asia/Dubai",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(finalExpiry),
  };
  const comps = template.components as MetaTemplateComponent[];
  const { values, missing } = paymentValues(comps, cfg.variableMap, ctx);
  const preview = renderTemplatePreview(comps, values);
  if (missing.length || preview.missing.length) {
    if (provider.expire) await provider.expire(created.ref);
    return fail(
      "template_unmapped",
      "The payment template has an unmapped variable. Nothing was sent.",
    );
  }
  try {
    const conversation = await ensureConversation(
      admin,
      input.orgId,
      target.recipient.id,
      channelId,
    );
    const message = await queueOutbound(admin, {
      orgId: input.orgId,
      conversationId: conversation.id,
      spec: { type: "template", template_id: template.id, values },
      body: [preview.headerText, preview.body].filter(Boolean).join("\n"),
      sentByUserId: input.actorId,
      priority: true,
      flowStepKey: input.flowStepKey,
    });
    await admin
      .from("fin_payment_requests")
      .update({ status: "sent", message_id: message.id })
      .eq("id", requestId)
      .eq("org_id", input.orgId);
  } catch (err) {
    console.error("[payments] message could not be queued", { error: redactText(err, 120) });
    if (provider.expire) await provider.expire(created.ref);
    return fail(
      "queue_failed",
      "The link was created but the message could not be queued, so the link was closed. Try again.",
    );
  }
  await addTimelineEvent(admin, {
    orgId: input.orgId,
    contactId: patient.id,
    type: "finance.payment_link_sent",
    actorType: input.actorId ? "user" : "system",
    actorId: input.actorId,
    payload: { request_id: requestId },
  });
  await bumpUsage(admin, input.orgId, "payments", "links_sent");
  return { ok: true, requestId, expiresAt: finalExpiry.toISOString() };
}

type FlowStepRequestRow = {
  id: string;
  status: string;
  message_id: string | null;
  expires_at: string | null;
  provider: string;
  provider_ref: string | null;
  failure_code: string | null;
  create_attempted_at: string | null;
};

type FlowStepReplay =
  | { kind: "none" }
  | { kind: "done"; result: { requestId: string; expiresAt: string } }
  | { kind: "refuse"; error: string }
  | { kind: "restart"; request: FlowStepRequestRow };

const REPLAY_AMBIGUOUS =
  "An earlier attempt of this step may have made a payment link at the gateway; it is not made again automatically. Check the gateway, then send a link by hand if needed.";

/**
 * What a replayed Payment link step already did (fin_payment_requests.flow_step_key):
 *  - failed: the step fails again (ambiguous creates are never repeated; staff decide on the fallback path)
 *  - its message was queued: done. A message queued but not linked (crash between queueing and linking) is linked now; one
 *    whose enqueue was lost is queued once (requeue_lost_flow_message) while the request is still live
 *  - no message, never asked the gateway ('pending', no create_attempted_at) or a link the gateway confirmed ('created'):
 *    restart (the caller closes it and starts over)
 *  - no message, asked the gateway but no answer stored: marked ambiguous_create, the step fails, nothing is created again
 *  - no message, cancelled or expired: the step fails; a request staff cancelled or the expiry closed is never replaced
 *  - none: this step never got as far as a request
 */
async function flowStepRequest(
  admin: AdminClient,
  orgId: string,
  key: string,
): Promise<FlowStepReplay> {
  const { data: request, error } = await admin
    .from("fin_payment_requests")
    .select(
      "id, status, message_id, expires_at, provider, provider_ref, failure_code, create_attempted_at",
    )
    .eq("org_id", orgId)
    .eq("flow_step_key", key)
    .maybeSingle();
  if (error) throw new Error("Could not read the payment request of this step");
  if (!request) return { kind: "none" };
  if (request.status === "failed")
    return {
      kind: "refuse",
      error:
        request.failure_code === AMBIGUOUS_CREATE
          ? REPLAY_AMBIGUOUS
          : "The payment link of this step failed earlier; it is not tried again automatically.",
    };
  // expires_at is written with the row; the flow step only reads the request id.
  const done: FlowStepReplay = {
    kind: "done",
    result: { requestId: request.id, expiresAt: request.expires_at ?? "" },
  };

  const { data: message } = await admin
    .from("messages")
    .select("id, status, wa_message_id")
    .eq("org_id", orgId)
    .eq("flow_step_key", key)
    .maybeSingle();
  if (message) {
    let status = request.status;
    if (!request.message_id) {
      // Queued but never linked to the request: link it now (and mark it sent if it was waiting for that).
      status = request.status === "created" ? "sent" : request.status;
      await admin
        .from("fin_payment_requests")
        .update(
          status !== request.status
            ? { message_id: message.id, status }
            : { message_id: message.id },
        )
        .eq("id", request.id)
        .eq("org_id", orgId)
        .is("message_id", null);
    }
    // Inserted but its enqueue was lost: queue it once, only while the link is still live.
    if (
      (status === "created" || status === "sent") &&
      message.status === "queued" &&
      !message.wa_message_id
    ) {
      const { error: requeueError } = await admin.rpc("requeue_lost_flow_message", {
        p_message_id: message.id,
        p_queue: "outbound_priority",
      });
      if (requeueError) throw new Error("Could not queue the payment message again");
    }
    return done;
  }
  if (request.message_id || request.status === "sent" || request.status === "paid") return done;

  if (request.status === "pending" && request.create_attempted_at) {
    // The gateway was asked but its answer was never stored: it may hold a link. Never ask it again.
    await admin
      .from("fin_payment_requests")
      .update({ status: "failed", failure_code: AMBIGUOUS_CREATE })
      .eq("id", request.id)
      .eq("org_id", orgId)
      .eq("status", "pending");
    return { kind: "refuse", error: REPLAY_AMBIGUOUS };
  }
  if (request.status === "pending" || request.status === "created")
    return { kind: "restart", request };
  return {
    kind: "refuse",
    error: `The payment link of this step was ${request.status} before it was sent; it is not replaced automatically.`,
  };
}

/** Closes a replayed step's request that never sent its message and releases the key. False if it changed meanwhile. */
async function closeUnsentFlowStepRequest(
  admin: AdminClient,
  orgId: string,
  request: FlowStepRequestRow,
): Promise<boolean> {
  const { data } = await admin
    .from("fin_payment_requests")
    .update({ flow_step_key: null, status: "failed", failure_code: "step_replayed" })
    .eq("id", request.id)
    .eq("org_id", orgId)
    .eq("status", request.status)
    .is("message_id", null)
    .select("id");
  return (data?.length ?? 0) > 0;
}

/** Cancels an open request and asks the gateway to close the link where it can. A payment that still arrives is recorded and flagged. */
export async function cancelPaymentRequest(
  admin: AdminClient,
  input: { orgId: string; requestId: string; provider?: PaymentProvider },
): Promise<Result<{ closedAtGateway: boolean }>> {
  const { data: req } = await admin
    .from("fin_payment_requests")
    .select("id, status, provider_ref")
    .eq("id", input.requestId)
    .eq("org_id", input.orgId)
    .maybeSingle();
  if (!req) return { ok: false, error: "Payment request not found." };
  const { data: updated } = await admin
    .from("fin_payment_requests")
    .update({ status: "cancelled" })
    .eq("id", req.id)
    .eq("org_id", input.orgId)
    .in("status", ["pending", "created", "sent"])
    .select("id");
  if (!updated?.length) return { ok: false, error: "Only an open request can be cancelled." };
  let closed = false;
  if (req.provider_ref) {
    const account = await loadAccount(admin, input.orgId, "payments");
    const provider = input.provider ?? (account ? buildPaymentProvider(admin, account) : null);
    if (provider?.expire) closed = await provider.expire(req.provider_ref);
  }
  return { ok: true, closedAtGateway: closed };
}
