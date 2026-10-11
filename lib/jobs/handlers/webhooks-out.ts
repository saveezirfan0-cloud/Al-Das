import { z } from "zod";

import { decryptSecret } from "@/lib/crypto";
import { registerHandler } from "@/lib/jobs/registry";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { PermanentJobError } from "@/lib/jobs/types";
import { safeRequest } from "@/lib/net/safe-request";
import { classifyAttempt } from "@/lib/webhooks/backoff";
import { signPayload, SIGNATURE_HEADER } from "@/lib/webhooks/sign";

/**
 * `webhooks_out` queue: { delivery_id } → POST the signed envelope to the subscriber's endpoint.
 *
 *   - idempotent: a delivery already marked success is skipped
 *   - the target is re-validated at connect time (no private addresses, no redirects)
 *   - the response body is read only up to 4 KB and never stored or logged
 *   - failures are retried with backoff through scheduled_jobs ('webhook.retry' → this queue),
 *     and marked dead after the last attempt
 */
const job = z.object({ delivery_id: z.string().uuid() });

registerHandler({
  queue: "webhooks_out",
  name: "webhooks_out.deliver",
  batchSize: 20,
  visibilityTimeout: 60,
  maxReads: 3,
  concurrency: "parallel",
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid webhooks_out job payload");
    const { admin, log } = ctx;

    const { data: delivery } = await admin
      .from("webhook_deliveries")
      .select("id, org_id, subscription_id, event, event_id, payload, status, attempts")
      .eq("id", parsed.data.delivery_id)
      .maybeSingle();
    if (!delivery) return; // endpoint deleted while queued
    if (delivery.status === "success" || delivery.status === "dead") return;

    const [{ data: sub }, { data: secretRow }] = await Promise.all([
      admin.from("webhook_subscriptions").select("id, url, active").eq("id", delivery.subscription_id).maybeSingle(),
      admin.from("webhook_secrets").select("secret_enc").eq("subscription_id", delivery.subscription_id).maybeSingle(),
    ]);
    if (!sub || !sub.active || !secretRow) {
      await admin
        .from("webhook_deliveries")
        .update({ status: "dead", error: "The endpoint is disabled or was deleted.", next_attempt_at: null })
        .eq("id", delivery.id);
      return;
    }

    const attempts = delivery.attempts + 1;
    const body = JSON.stringify(delivery.payload);
    let outcome;
    try {
      const res = await safeRequest(sub.url, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Pulse-Webhooks/1.0",
          "X-Pulse-Event": delivery.event,
          "X-Pulse-Delivery": delivery.id,
          [SIGNATURE_HEADER]: signPayload(decryptSecret(secretRow.secret_enc), body),
        },
        timeoutMs: 10_000,
        deadlineMs: 20_000, // the whole attempt, however slowly the receiver answers (queue visibility is 60 s)
        maxBytes: 4096,
        onOverflow: "truncate",
        maxRedirects: 0,
      });
      outcome = classifyAttempt({ status: res.status }, attempts);
    } catch (err) {
      outcome = classifyAttempt({ error: err instanceof Error ? err : { message: "unknown" } }, attempts);
    }

    const now = new Date();
    await admin
      .from("webhook_deliveries")
      .update({
        status: outcome.status,
        attempts,
        response_code: outcome.responseCode,
        error: outcome.error,
        delivered_at: outcome.status === "success" ? now.toISOString() : null,
        next_attempt_at: outcome.retryInSeconds ? new Date(now.getTime() + outcome.retryInSeconds * 1000).toISOString() : null,
      })
      .eq("id", delivery.id);

    if (outcome.retryInSeconds) {
      await scheduleJob({
        kind: "webhook.retry",
        payload: { delivery_id: delivery.id },
        runAt: new Date(now.getTime() + outcome.retryInSeconds * 1000),
        orgId: delivery.org_id,
        dedupeKey: `webhook:${delivery.id}:${attempts}`,
      });
    }
    // ids and codes only: never the URL's query string, the payload or the response
    log.info("webhook attempt", { deliveryId: delivery.id, event: delivery.event, attempt: attempts, outcome: outcome.status, code: outcome.responseCode });
  },
});
