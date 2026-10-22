import "server-only";

import { upsertExternalRef } from "@/lib/contacts/import-writer";
import { emit } from "@/lib/events/emit";
import { loadAccount } from "@/lib/integrations/accounts";
import type { SendSpec } from "@/lib/inbox/send";
import { enqueue } from "@/lib/jobs/enqueue";
import type { JobContext } from "@/lib/jobs/types";
import type { AdminClient } from "@/lib/supabase/admin";
import { isAuthTemplate, isMarketingBlocked, isTemplateSendable } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import type { SanoflowClient, SanoflowSendResult } from "./client";
import { readSanoflowConfig, sanoflowPhone, type SanoflowConfig } from "./config";
import {
  contactFullName,
  firstLastWord,
  readOutboundContext,
  shouldRecoverInvalidChannel,
  shouldTagAfterSend,
  type OutboundContext,
} from "./contacts";
import { sanoflowMapperValues } from "./params";
import { buildSanoflowClientFor } from "./server";

/** A send Sanoflow throttled: the queue re-delivers the job after its visibility timeout. */
export class SanoflowRetryError extends Error {
  constructor() {
    super("sanoflow send throttled; retrying");
    this.name = "SanoflowRetryError";
  }
}

export type SanoflowOutboundInput = {
  /** `payload` carries the queueing context (payload.context: appointment reminder or recall send). */
  message: { id: string; org_id: string; payload?: unknown };
  conversation: { id: string };
  contact: { id: string; phone_e164: string | null; stop_marketing: boolean | null };
  spec: SendSpec;
};

async function markFailed(admin: AdminClient, id: string, code: number, text: string) {
  await admin
    .from("messages")
    .update({ status: "failed", error_code: code, error_message: text.slice(0, 500) })
    .eq("id", id)
    .in("status", ["queued", "sending"]);
}

async function failAndTell(
  admin: AdminClient,
  a: SanoflowOutboundInput,
  code: number,
  text: string,
  category: string,
) {
  await markFailed(admin, a.message.id, code, text);
  await emit(a.message.org_id, "message.failed", {
    message_id: a.message.id,
    conversation_id: a.conversation.id,
    code,
    category,
  });
}

/**
 * Sends a queued message on a WhatsApp number that sends through Sanoflow (channels.transport = 'sanoflow', OQ-182). Called by
 * the outbound job after its own guards (training workspace, campaign withdrawal, number paused, template time limit, the
 * per-number send slot), so everything here is Sanoflow-specific:
 *
 *   the `sanoflow` integration is switched on; the message is an APPROVED, non-authentication template with a Sanoflow
 *   template number; a Marketing template never reaches someone who stopped marketing (checked again now, rule 11); the
 *   body values fit Sanoflow's ordered list; the contact has an E.164 phone.
 *
 * The message is claimed queued -> sending first. A message already "sending" was handed to Sanoflow by a worker that died
 * before recording the answer: it may have arrived, so it is marked failed and never sent again (no idempotency key). The
 * same holds for a timeout or 5xx. Those ambiguous failures emit no `message.failed`, so neither the template retry nor the
 * SMS fallback sends a second copy.
 */
export async function deliverSanoflowOutbound(
  admin: AdminClient,
  a: SanoflowOutboundInput,
  ctx: Pick<JobContext, "log" | "readCt">,
  deps: {
    fetchFn?: typeof fetch;
    client?: SanoflowClient;
    phoneFormat?: "digits" | "plus";
    config?: SanoflowConfig;
  } = {},
): Promise<void> {
  if (a.spec.type !== "template") {
    await markFailed(
      admin,
      a.message.id,
      -1,
      "This number sends through Sanoflow, which Pulse uses for approved templates only.",
    );
    return;
  }

  let client = deps.client ?? null;
  let phoneFormat = deps.phoneFormat ?? "digits";
  let config: SanoflowConfig = deps.config ?? readSanoflowConfig({ phone_format: phoneFormat });
  if (!client) {
    const account = await loadAccount(admin, a.message.org_id, "sanoflow");
    if (!account?.enabled) {
      await markFailed(admin, a.message.id, -1, "Sending through Sanoflow is switched off.");
      return;
    }
    const built = buildSanoflowClientFor(admin, account, deps.fetchFn);
    if (!built) {
      await markFailed(admin, a.message.id, -1, "The Sanoflow API key is missing.");
      return;
    }
    client = built.client;
    phoneFormat = built.config.phoneFormat;
    config = built.config;
  }
  const context = readOutboundContext(a.message.payload);

  const { data: tpl } = await admin
    .from("wa_templates")
    .select("name, components, status, parameter_format, category, sanoflow_template_id")
    .eq("id", a.spec.template_id)
    .eq("org_id", a.message.org_id)
    .maybeSingle();
  if (!tpl) {
    await markFailed(admin, a.message.id, -1, "Template not found.");
    return;
  }
  if (!isTemplateSendable(tpl.status)) {
    await markFailed(
      admin,
      a.message.id,
      132001,
      `Template "${tpl.name}" is ${tpl.status}, not APPROVED.`,
    );
    return;
  }
  if (isAuthTemplate(tpl.category)) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      "One-time code templates are not sent through Sanoflow.",
    );
    return;
  }
  if (isMarketingBlocked(tpl.category, a.contact.stop_marketing)) {
    await failAndTell(
      admin,
      a,
      131050,
      "The recipient opted out of marketing messages.",
      "recipient",
    );
    return;
  }
  const templateNumber = Number(tpl.sanoflow_template_id);
  if (!Number.isSafeInteger(templateNumber) || templateNumber <= 0) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      `Template "${tpl.name}" has no Sanoflow template number. Add it under Settings, Integrations, Sanoflow.`,
    );
    return;
  }
  const mapped = sanoflowMapperValues(
    tpl.components as unknown as MetaTemplateComponent[],
    a.spec.values,
    tpl.parameter_format === "named" ? "named" : "positional",
  );
  if (!mapped.ok) {
    await markFailed(admin, a.message.id, -1, mapped.reason);
    return;
  }
  const phone = sanoflowPhone(a.contact.phone_e164, phoneFormat);
  if (!phone) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      "The contact has no phone number Sanoflow can send to.",
    );
    return;
  }

  const { data: claimed } = await admin
    .from("messages")
    .update({ status: "sending" })
    .eq("id", a.message.id)
    .eq("status", "queued")
    .select("id");
  if (!claimed?.length) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      "The send was interrupted and may have arrived; it was not sent again.",
    );
    return;
  }

  const send = { templateId: templateNumber, phone, values: mapped.values };
  let r = await client.sendTemplate(send);
  if (!r.ok && shouldRecoverInvalidChannel(context, r)) {
    const again = await recoverInvalidChannel(admin, a, client, phone, ctx);
    if (again) r = await client.sendTemplate(send);
    // The second answer is final: a 429 now is not queued again, because a re-run would repeat contacts/add.
    if (!r.ok) r = { ...r, retryable: false };
  }
  if (r.ok) {
    const externalId = `sanoflow:${r.providerMessageId ?? a.message.id}`.slice(0, 200);
    await admin
      .from("messages")
      .update({ wa_message_id: externalId, status: "sent", error_code: null, error_message: null })
      .eq("id", a.message.id);
    await admin
      .from("conversations")
      .update({ last_outbound_at: new Date().toISOString() })
      .eq("id", a.conversation.id);
    await emit(a.message.org_id, "message.sent", {
      message_id: a.message.id,
      conversation_id: a.conversation.id,
      kind: "template",
    });
    await queueTagging(a, context, config, ctx);
    return;
  }
  await handleFailure(admin, a, r, ctx);
}

async function handleFailure(
  admin: AdminClient,
  a: SanoflowOutboundInput,
  r: Extract<SanoflowSendResult, { ok: false }>,
  ctx: Pick<JobContext, "log" | "readCt">,
): Promise<void> {
  if (r.retryable && ctx.readCt < 5) {
    await admin.from("messages").update({ status: "queued" }).eq("id", a.message.id);
    ctx.log.warn("sanoflow send throttled", { messageId: a.message.id, code: r.code });
    throw new SanoflowRetryError();
  }
  ctx.log.warn("sanoflow send failed", { messageId: a.message.id, code: r.code });
  if (r.ambiguous) {
    await markFailed(
      admin,
      a.message.id,
      -1,
      "Sanoflow did not answer in time; the message may have arrived, so it was not sent again.",
    );
    return;
  }
  if (r.stopMarketing) {
    await admin.from("contacts").update({ stop_marketing: true }).eq("id", a.contact.id);
    await emit(a.message.org_id, "contact.stop_marketing", {
      contact_id: a.contact.id,
      code: 131050,
    });
    await failAndTell(
      admin,
      a,
      131050,
      "The recipient opted out of marketing messages.",
      "recipient",
    );
    return;
  }
  await failAndTell(
    admin,
    a,
    -1,
    r.auth
      ? "Sanoflow rejected the API key."
      : r.code === "breaker_open"
        ? "Sanoflow has been failing; sends are paused for a few minutes."
        : r.invalidChannel
          ? "Sanoflow does not know this number's WhatsApp channel."
          : "Sanoflow refused the message.",
    r.auth ? "account" : "message",
  );
}

/**
 * docs/49 D9, as Make's reminder error path: Sanoflow refused the reminder with "Invalid channel details.", so look the
 * number up in Sanoflow; for a contact found, create it again on v1 (first and last word of the name) and let the caller send
 * the template once more. No contact found, or any failed or ambiguous answer, stops here: nothing is sent again after an
 * answer nobody can read. Returns true when the template should be sent again.
 */
async function recoverInvalidChannel(
  admin: AdminClient,
  a: SanoflowOutboundInput,
  client: SanoflowClient,
  phone: string,
  ctx: Pick<JobContext, "log">,
): Promise<boolean> {
  const found = await client.contactsList({ phone });
  if (!found.ok || found.value.length === 0) {
    ctx.log.info("sanoflow invalid channel: no contact to re-create", {
      messageId: a.message.id,
      code: found.ok ? "none_found" : found.code,
    });
    return false;
  }
  const { data: person } = await admin
    .from("contacts")
    .select("first_name, last_name, full_name")
    .eq("id", a.contact.id)
    .maybeSingle();
  const name = firstLastWord(contactFullName(person ?? {}));
  const added = await client.contactsAdd({ firstName: name.first, lastName: name.last, phone });
  if (!added.ok) {
    ctx.log.warn("sanoflow contact add failed", { messageId: a.message.id, code: added.code });
    return false;
  }
  if (added.value.contactId !== null) {
    await upsertExternalRef(admin, {
      orgId: a.message.org_id,
      source: "sanoflow",
      entity: "contact",
      externalId: String(added.value.contactId),
      localTable: "contacts",
      localId: a.contact.id,
    });
  }
  return true;
}

/**
 * docs/49 D11: after a Live recall send, Make writes its tag (and the chronic label) to the Sanoflow contact. That happens in
 * its own job (sanoflow_tags) so a failed or slow tag write can never touch the message. Ids only in the job.
 */
async function queueTagging(
  a: SanoflowOutboundInput,
  context: OutboundContext | null,
  config: SanoflowConfig,
  ctx: Pick<JobContext, "log">,
): Promise<void> {
  if (!shouldTagAfterSend(context, config)) return;
  try {
    await enqueue("sanoflow_tags", {
      org_id: a.message.org_id,
      contact_id: a.contact.id,
      programme: context.programme,
    });
  } catch {
    ctx.log.warn("sanoflow tag job not queued", { messageId: a.message.id });
  }
}
