"use server";

import { revalidatePath } from "next/cache";

import "@/lib/jobs/handlers";

import { recordAudit } from "@/lib/audit";
import { requirePerm } from "@/lib/auth/session";
import { dbDrainDeps, dbSchedulerDeps } from "@/lib/jobs/db";
import { isQueueName, SCHEDULER_QUEUE } from "@/lib/jobs/queues";
import { drainQueue } from "@/lib/jobs/runner";
import { runScheduler } from "@/lib/jobs/scheduler";
import { createAdminClient } from "@/lib/supabase/admin";

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

export async function retryDeadLetter(id: number): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("job_retry_dead_letter", {
    p_id: id,
    p_user_id: member.userId,
  });
  if (error) return { ok: false, error: "Could not retry this message." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "dead_letter.retried",
    entity: "dead_letter",
    entityId: String(id),
    diff: { msg_id: data },
  });
  revalidatePath("/settings/system-health");
  return { ok: true, message: "Message re-queued." };
}

export async function discardDeadLetter(id: number): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const { error } = await admin
    .from("dead_letters")
    .update({
      resolved_at: new Date().toISOString(),
      resolved_by: member.userId,
      resolution: "discarded",
    })
    .eq("id", id)
    .is("resolved_at", null);
  if (error) return { ok: false, error: "Could not discard this message." };
  await recordAudit(admin, {
    orgId: member.orgId,
    userId: member.userId,
    action: "dead_letter.discarded",
    entity: "dead_letter",
    entityId: String(id),
  });
  revalidatePath("/settings/system-health");
  return { ok: true, message: "Message discarded." };
}

/** Drain a queue right now (same code path as the cron-driven route). */
export async function runQueueNow(queue: string): Promise<ActionResult> {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  if (queue === SCHEDULER_QUEUE) {
    const r = await runScheduler(dbSchedulerDeps(admin), {
      worker: `manual:${member.userId.slice(0, 8)}`,
    });
    revalidatePath("/settings/system-health");
    return {
      ok: true,
      message: `Scheduler: ${r.claimed} claimed, ${r.enqueued} enqueued, ${r.failed} failed.`,
    };
  }
  if (!isQueueName(queue)) return { ok: false, error: "Unknown queue." };
  const r = await drainQueue(queue, dbDrainDeps(admin));
  revalidatePath("/settings/system-health");
  if (r.error && r.read === 0) return { ok: false, error: r.error };
  return {
    ok: true,
    message: `${queue}: ${r.read} read, ${r.processed} processed, ${r.failed} failed, ${r.deadLettered} dead-lettered.`,
  };
}
