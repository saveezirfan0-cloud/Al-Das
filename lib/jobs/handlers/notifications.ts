import { z } from "zod";

import { sendEmail } from "@/lib/email";
import { registerHandler } from "@/lib/jobs/registry";
import { PermanentJobError } from "@/lib/jobs/types";
import { handleScheduled, scheduledEnvelope } from "@/lib/jobs/handlers/reminders";
import { createNotification } from "@/lib/notifications";

/**
 * `notifications` queue: transactional email and in-app notifications.
 *   { type: 'email', to, subject, text, html? }
 *   { type: 'in_app', org_id, user_id, kind, title, body?, payload? }
 *   { kind: 'task.due' | 'enquiry.sla', scheduled_job_id, … }  scheduled reminders (lib/jobs/handlers/reminders.ts)
 */
const emailJob = z.object({
  type: z.literal("email"),
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
});

const inAppJob = z.object({
  type: z.literal("in_app"),
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
  kind: z.string().min(1),
  title: z.string().min(1),
  body: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const notificationJob = z.discriminatedUnion("type", [emailJob, inAppJob]);
export type NotificationJob = z.infer<typeof notificationJob>;

registerHandler({
  queue: "notifications",
  name: "notifications.dispatch",
  batchSize: 50,
  visibilityTimeout: 60,
  maxReads: 5,
  concurrency: "parallel",
  async handler(raw, ctx) {
    const scheduled = scheduledEnvelope.safeParse(raw);
    if (scheduled.success) {
      const outcome = await handleScheduled(scheduled.data, ctx.admin);
      ctx.log.info(`scheduled ${scheduled.data.kind}: ${outcome}`);
      return;
    }
    const parsed = notificationJob.safeParse(raw);
    if (!parsed.success)
      throw new PermanentJobError(`invalid notification job: ${parsed.error.issues[0]?.message}`);
    const job = parsed.data;
    if (job.type === "email") {
      const res = await sendEmail({
        to: job.to,
        subject: job.subject,
        text: job.text,
        html: job.html,
      });
      if (!res.delivered && res.reason !== "email_not_configured")
        throw new Error(`email failed: ${res.reason}`);
      return;
    }
    await createNotification(ctx.admin, {
      orgId: job.org_id,
      userId: job.user_id,
      type: job.kind,
      title: job.title,
      body: job.body ?? null,
      payload: (job.payload ?? {}) as never,
    });
  },
});
