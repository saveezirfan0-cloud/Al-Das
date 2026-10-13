import "server-only";

import { queueOutbound, RetryExistsError, sendSpecSchema } from "@/lib/inbox/send";
import type { AdminClient } from "@/lib/supabase/admin";
import {
  readRetryMarker,
  templateRetryDecision,
  type RetrySkipReason,
} from "@/lib/templates/delivery";

/**
 * Phase 20d retry-on-fail for template messages outside campaigns. Called for every `message.failed` (outbound
 * job and status webhook) and by the appointment-reminder listener; idempotent: a failed message gets at most one
 * retry (messages.retry_of_message_id is unique), so two callers, a replayed event or a retried job queue nothing
 * twice. The copy goes through queueOutbound like any other send, so every send-time guard (window, opt-out,
 * training, rate limit, TTL) runs again when it is actually sent.
 */

export type RetryOutcome =
  | { status: "queued" | "exists"; retryMessageId: string }
  | { status: "skipped"; reason: RetrySkipReason | "not_found" | "not_failed" };

export async function maybeRetryTemplateMessage(
  admin: AdminClient,
  orgId: string,
  messageId: string,
  now: Date = new Date(),
): Promise<RetryOutcome> {
  const existing = await findRetry(admin, orgId, messageId);
  if (existing) return { status: "exists", retryMessageId: existing };

  const { data: msg } = await admin
    .from("messages")
    .select(
      "id, org_id, conversation_id, direction, kind, status, error_code, payload, body, at, sent_by_user_id, flow_run_id, campaign_recipient_id",
    )
    .eq("id", messageId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!msg || msg.direction !== "out") return { status: "skipped", reason: "not_found" };
  if (msg.status !== "failed") return { status: "skipped", reason: "not_failed" };

  const spec = sendSpecSchema.safeParse((msg.payload as { send?: unknown } | null)?.send);
  const isTemplate = spec.success && spec.data.type === "template";
  let template: { retry_on_fail: boolean; ttl_seconds: number | null } | null = null;
  if (spec.success && spec.data.type === "template") {
    const { data } = await admin
      .from("wa_templates")
      .select("retry_on_fail, ttl_seconds")
      .eq("id", spec.data.template_id)
      .eq("org_id", orgId)
      .maybeSingle();
    template = data;
  }

  const marker = readRetryMarker(msg.payload);
  const decision = templateRetryDecision({
    retryOnFail: template?.retry_on_fail ?? false,
    isTemplate,
    campaignRecipientId: msg.campaign_recipient_id,
    errorCode: msg.error_code,
    previousRetries: marker?.attempt ?? 0,
    ttlSeconds: template?.ttl_seconds ?? null,
    originAt: marker?.origin_at ?? msg.at,
    now,
  });
  if (!decision.retry || !spec.success) {
    return { status: "skipped", reason: decision.retry ? "not_template" : decision.reason };
  }

  try {
    const copy = await queueOutbound(admin, {
      orgId,
      conversationId: msg.conversation_id,
      spec: spec.data,
      body: msg.body,
      sentByUserId: msg.sent_by_user_id,
      flowRunId: msg.flow_run_id,
      priority: false, // automated re-send: the bulk lane, never ahead of live chat
      retryOf: {
        messageId: msg.id,
        attempt: decision.attempt,
        originAt: marker?.origin_at ?? msg.at,
      },
      delaySeconds: decision.delaySeconds,
    });
    return { status: "queued", retryMessageId: copy.id };
  } catch (err) {
    if (err instanceof RetryExistsError) {
      const id = await findRetry(admin, orgId, messageId);
      if (id) return { status: "exists", retryMessageId: id };
    }
    throw err;
  }
}

async function findRetry(
  admin: AdminClient,
  orgId: string,
  messageId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("messages")
    .select("id")
    .eq("org_id", orgId)
    .eq("retry_of_message_id", messageId)
    .maybeSingle();
  return data?.id ?? null;
}
