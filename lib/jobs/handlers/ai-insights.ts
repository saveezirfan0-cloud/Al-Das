import { intentJobSchema, processIntentJob } from "@/lib/ai/intent/job";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";

/**
 * `ai_insights` queue: { type: 'intent', message_id } -> look at one inbound patient message.
 *   - emergency wording: deterministic, runs even with AI off, escalates to people (idempotent per message)
 *   - AI label (booking / price / complaint / report request / emergency): only with the AI switch AND the intent switch on
 * Counts and short reasons are logged; never the message, the label of what was said, or a name.
 */
registerHandler({
  queue: "ai_insights",
  name: "ai_insights.intent",
  batchSize: 10,
  visibilityTimeout: 90,
  maxReads: 5,
  concurrency: "serial",
  async handler(raw, ctx) {
    const parsed = intentJobSchema.safeParse(raw);
    if (!parsed.success) throw new PermanentJobError("invalid ai_insights job payload");
    const outcome = await processIntentJob(ctx.admin, parsed.data.message_id);
    ctx.log.info("ai_insights.intent", { outcome });
  },
});
