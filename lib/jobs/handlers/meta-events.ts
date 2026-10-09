import { z } from "zod";

import {
  processAccountUpdate,
  processBusinessUsername,
  processInbound,
  processPhoneQuality,
  processStatus,
  processTemplateCategory,
  processTemplateQuality,
  processTemplateStatus,
  processUserIdUpdate,
} from "@/lib/inbox/inbound";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";
import { parseWebhookBody } from "@/lib/whatsapp/parse";

/**
 * `meta_events` queue: { event_id } → webhook_events_in row → parse → route each
 * change. Everything downstream is idempotent (unique wa_message_id, forward-only
 * statuses, upserts), so a retry after a partial failure is safe.
 */
const job = z.object({ event_id: z.string().uuid() });

registerHandler({
  queue: "meta_events",
  name: "meta_events.process",
  batchSize: 50,
  visibilityTimeout: 90,
  maxReads: 5,
  concurrency: "serial", // preserves message order per webhook burst
  async handler(raw, ctx) {
    const parsed = job.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid meta_events job payload");
    const { admin, log } = ctx;

    const { data: row, error } = await admin
      .from("webhook_events_in")
      .select("id, payload, processed_at, attempts")
      .eq("id", parsed.data.event_id)
      .maybeSingle();
    if (error) throw new Error(`webhook_events_in read: ${error.message}`);
    if (!row) throw new PermanentJobError(`webhook event ${parsed.data.event_id} not found`);
    if (row.processed_at) return; // already done (duplicate delivery)

    await admin
      .from("webhook_events_in")
      .update({ attempts: (row.attempts ?? 0) + 1 })
      .eq("id", row.id);

    const result = parseWebhookBody(row.payload);
    if (!result.ok) {
      await admin
        .from("webhook_events_in")
        .update({
          processed_at: new Date().toISOString(),
          error: `unparseable: ${result.error}`.slice(0, 1000),
        })
        .eq("id", row.id);
      log.warn("unparseable webhook payload", { eventId: row.id });
      return;
    }

    const counts: Record<string, number> = {};
    try {
      for (const e of result.events) {
        counts[e.kind] = (counts[e.kind] ?? 0) + 1;
        switch (e.kind) {
          case "message":
            await processInbound(admin, e, log);
            break;
          case "status":
            await processStatus(admin, e, log);
            break;
          case "template_status":
            await processTemplateStatus(admin, e);
            break;
          case "template_category":
            await processTemplateCategory(admin, e);
            break;
          case "template_quality":
            await processTemplateQuality(admin, e);
            break;
          case "phone_quality":
            await processPhoneQuality(admin, e);
            break;
          case "account_update":
            await processAccountUpdate(admin, e);
            break;
          case "user_id_update":
            await processUserIdUpdate(admin, e);
            break;
          case "business_username":
            await processBusinessUsername(admin, e);
            break;
          case "unknown":
            log.info("unhandled webhook field", { field: e.field });
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await admin
        .from("webhook_events_in")
        .update({ error: message.slice(0, 1000) })
        .eq("id", row.id);
      throw err; // retry via visibility timeout; dead-letter after maxReads
    }

    await admin
      .from("webhook_events_in")
      .update({ processed_at: new Date().toISOString(), error: null })
      .eq("id", row.id);
    log.info("webhook processed", { eventId: row.id, counts });
  },
});
