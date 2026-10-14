import { z } from "zod";

import { addTimelineEvent } from "@/lib/contacts/timeline";
import type { EnquiryStatus } from "@/lib/enquiries/constants";
import { registerEnquiryListeners } from "@/lib/enquiries/notify";
import { shouldRaiseBreach } from "@/lib/enquiries/sla";
import { emit } from "@/lib/events/emit";
import { PermanentJobError } from "@/lib/jobs/types";
import { handleUnsnooze } from "@/lib/inbox/snooze-server";
import { handleEscalation } from "@/lib/notify/escalation-job";
import { notify } from "@/lib/notify/dispatch-db";
import type { AdminClient } from "@/lib/supabase/admin";
import { reminderStillValid } from "@/lib/tasks/due";
import { spawnNextOccurrence } from "@/lib/tasks/service";

// The SLA job emits enquiry events, so the notification listeners must be registered here too.
registerEnquiryListeners();

/**
 * Scheduled-job envelopes (see toQueueMessage in lib/jobs/scheduler.ts) delivered to the
 * `notifications` queue:
 *   task.due     → in-app reminder for the assignee (skipped if done or moved)
 *   enquiry.sla  → raise an SLA breach once, if the enquiry is still open and untouched
 *   inbox.escalate → escalation ladder for a conversation nobody owns (lib/notify/escalation-job.ts)
 *   inbox.unsnooze → a snoozed conversation comes back (lib/inbox/snooze-server.ts; stale snoozes are skipped)
 *   task.recur   → the next task of a recurring series (idempotent; skipped if the task moved or stopped repeating)
 * All re-check state at fire time, so stale or duplicate jobs are no-ops.
 */
export const scheduledEnvelope = z.object({
  kind: z.string().min(1),
  org_id: z.string().uuid().nullish(),
  scheduled_job_id: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});
export type ScheduledEnvelope = z.infer<typeof scheduledEnvelope>;

const taskDuePayload = z.object({ task_id: z.string().uuid(), due_at: z.string() });
const slaPayload = z.object({ enquiry_id: z.string().uuid() });

export async function handleScheduled(env: ScheduledEnvelope, admin: AdminClient): Promise<string> {
  if (!env.org_id) throw new PermanentJobError(`${env.kind} job has no org`);
  switch (env.kind) {
    case "task.due": {
      const p = taskDuePayload.safeParse(env.payload);
      if (!p.success) throw new PermanentJobError("invalid task.due payload");
      return handleTaskDue(admin, env.org_id, p.data);
    }
    case "enquiry.sla": {
      const p = slaPayload.safeParse(env.payload);
      if (!p.success) throw new PermanentJobError("invalid enquiry.sla payload");
      return handleEnquirySla(admin, env.org_id, p.data.enquiry_id);
    }
    case "inbox.escalate":
      return handleEscalation(admin, env.org_id, env.payload);
    case "inbox.unsnooze":
      return handleUnsnooze(admin, env.org_id, env.payload);
    case "task.recur": {
      const p = taskDuePayload.safeParse(env.payload);
      if (!p.success) throw new PermanentJobError("invalid task.recur payload");
      return handleTaskRecur(admin, env.org_id, p.data);
    }
    default:
      throw new PermanentJobError(`unknown scheduled kind ${env.kind}`);
  }
}

async function handleTaskDue(
  admin: AdminClient,
  orgId: string,
  p: z.infer<typeof taskDuePayload>,
): Promise<string> {
  const { data: task } = await admin
    .from("tasks")
    .select("id, subject, done, due_at, assignee_id, created_by, enquiry_id, contact_id, due_notified_for")
    .eq("org_id", orgId)
    .eq("id", p.task_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!task || !reminderStillValid(task, p.due_at)) return "skipped";
  if (task.due_notified_for && new Date(task.due_notified_for).getTime() === new Date(task.due_at).getTime())
    return "already_notified";
  const userId = task.assignee_id ?? task.created_by;
  if (!userId) return "no_recipient";
  await notify(admin, {
    orgId,
    userIds: [userId],
    event: "task.due",
    type: "task.due",
    title: "Task due",
    body: task.subject,
    payload: { task_id: task.id, enquiry_id: task.enquiry_id },
    ids: { task_id: task.id, enquiry_id: task.enquiry_id },
  });
  await admin.from("tasks").update({ due_notified_for: task.due_at }).eq("id", task.id).eq("org_id", orgId);
  await emit(orgId, "task.due", {
    task_id: task.id,
    enquiry_id: task.enquiry_id,
    contact_id: task.contact_id,
    assignee_id: userId,
  });
  return "notified";
}

async function handleTaskRecur(
  admin: AdminClient,
  orgId: string,
  p: z.infer<typeof taskDuePayload>,
): Promise<string> {
  const { data: task } = await admin
    .from("tasks")
    .select("id, due_at, recurrence")
    .eq("org_id", orgId)
    .eq("id", p.task_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!task || !task.recurrence) return "skipped";
  // A moved task has its own job for the new time.
  if (new Date(task.due_at).getTime() !== new Date(p.due_at).getTime()) return "moved";
  const created = await spawnNextOccurrence({ admin, orgId, userId: null }, task.id);
  return created ? "spawned" : "exists";
}

async function handleEnquirySla(admin: AdminClient, orgId: string, enquiryId: string): Promise<string> {
  const { data: e } = await admin
    .from("enquiries")
    .select("id, number, title, status, deleted_at, assignee_id, contact_id, sla_due_at, first_touch_at, sla_breached_at")
    .eq("org_id", orgId)
    .eq("id", enquiryId)
    .maybeSingle();
  if (!e || !shouldRaiseBreach({ ...e, status: e.status as EnquiryStatus }, new Date())) return "skipped";
  // Claim the breach: only one worker wins the null → timestamp transition.
  const { data: claimed } = await admin
    .from("enquiries")
    .update({ sla_breached_at: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("id", e.id)
    .is("sla_breached_at", null)
    .select("id");
  if (!claimed?.length) return "already_raised";
  await addTimelineEvent(admin, {
    orgId,
    contactId: e.contact_id,
    enquiryId: e.id,
    type: "enquiry.sla_breached",
    actorType: "system",
    payload: { sla_due_at: e.sla_due_at },
  });
  await emit(orgId, "enquiry.sla_breached", {
    enquiry_id: e.id,
    number: e.number,
    title: e.title,
    assignee_id: e.assignee_id,
    actor_id: null,
  });
  return "breached";
}
