import "server-only";

import { serverEnv } from "@/lib/env";
import { bumpUsage } from "@/lib/integrations/accounts";
import { readSmsConfig, smsCallbackBase } from "@/lib/integrations/sms/config";
import { fromProviderStatus, previousStatusesFor } from "@/lib/integrations/sms/status";
import { verifyTwilioSignature } from "@/lib/integrations/sms/twilio";
import { parseForm } from "@/lib/integrations/webhook";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Delivery receipts for the SMS fallback (POST /api/webhooks/integrations/sms/<account id>?m=<sms id>).
 * Signature checked against the exact callback URL we gave the provider, then each (message, status) pair is applied once and
 * only forward: a late "sent" never overwrites "delivered". An unsubscribe error also records the person's SMS opt-out.
 */

type Receipt = {
  providerMessageId: string;
  status: string;
  errorCode: string | null;
  smsId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Applies one receipt. Returns an outcome word for the idempotency record. */
export async function applySmsReceipt(
  admin: AdminClient,
  orgId: string,
  r: Receipt,
): Promise<string> {
  const next = fromProviderStatus(r.status);
  if (!next) return "ignored_status";

  // Match by our id when the callback carries it (it survives the race with our own update), else by the provider's id.
  const find = admin
    .from("sms_messages")
    .select("id, org_id, contact_id, status, provider_message_id")
    .eq("org_id", orgId);
  const { data: rows } =
    r.smsId && UUID.test(r.smsId)
      ? await find.eq("id", r.smsId).limit(1)
      : await find.eq("provider_message_id", r.providerMessageId).limit(1);
  const row = rows?.[0];
  if (!row) return "unknown_message";
  if (row.provider_message_id && row.provider_message_id !== r.providerMessageId)
    return "mismatched_message";

  const patch: Record<string, unknown> = { status: next };
  if (!row.provider_message_id) patch.provider_message_id = r.providerMessageId.slice(0, 80);
  if (next === "delivered") patch.delivered_at = new Date().toISOString();
  if (r.errorCode && (next === "failed" || next === "undelivered"))
    patch.error_code = r.errorCode.slice(0, 40);
  const { data: updated } = await admin
    .from("sms_messages")
    .update(patch as never)
    .eq("id", row.id)
    .in("status", previousStatusesFor(next))
    .select("id");

  if (updated?.length) {
    if (next === "delivered") await bumpUsage(admin, orgId, "sms", "delivered");
    if (next === "failed" || next === "undelivered") await bumpUsage(admin, orgId, "sms", "failed");
  }
  if (r.errorCode === "21610" && row.contact_id) {
    await admin
      .from("contacts")
      .update({ sms_opt_out_at: new Date().toISOString() })
      .eq("id", row.contact_id)
      .eq("org_id", orgId);
    await bumpUsage(admin, orgId, "sms", "opted_out");
  }
  return updated?.length ? `applied_${next}` : "not_forward";
}

export function smsWebhookSpec(): WebhookSpec {
  return {
    kind: "sms",
    provider: "twilio",
    verify(ctx) {
      // Phase 20h: only the Twilio-style gateway signs receipts. The generic HTTP gateway has none, so nothing posted to this
      // address for such an account is ever believed (it is answered like any bad signature).
      if (readSmsConfig(ctx.config).provider !== "twilio") return false;
      const url = smsCallbackBase(serverEnv().APP_URL, ctx.account.id) + ctx.search;
      return verifyTwilioSignature(
        ctx.secrets.auth_token ?? "",
        url,
        parseForm(ctx.raw),
        ctx.headers.get("x-twilio-signature"),
      );
    },
    parse(raw, ctx) {
      const form = parseForm(raw);
      const sid = form.MessageSid ?? form.SmsSid;
      const status = form.MessageStatus ?? form.SmsStatus;
      if (!sid || !status) throw new Error("not a status callback");
      const smsId = new URLSearchParams(ctx.search).get("m");
      const data: Receipt = {
        providerMessageId: sid,
        status,
        errorCode: form.ErrorCode || null,
        smsId,
      };
      return [{ key: `${sid}:${status}`, data }];
    },
    async handle(event, ctx) {
      return applySmsReceipt(ctx.admin, ctx.account.org_id, event.data as Receipt);
    },
  };
}
