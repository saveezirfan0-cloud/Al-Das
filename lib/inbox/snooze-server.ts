import "server-only";

import { z } from "zod";

import { scheduleJob } from "@/lib/jobs/enqueue";
import { PermanentJobError } from "@/lib/jobs/types";
import { unsnoozeDedupeKey } from "@/lib/inbox/snooze";
import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Snooze (Phase F). Setting it writes the conversation's snoozed_until and a scheduled_jobs row (inbox.unsnooze) for
 * that moment; the job clears the snooze only if it is still the same one (a new snooze, a patient's message or a
 * close moved it on), so a retried or stale job does nothing. Callers check inbox.send and that the member can see
 * the conversation.
 */
export async function setSnooze(
  admin: AdminClient,
  a: { orgId: string; userId: string; conversationId: string; until: Date },
): Promise<boolean> {
  const { data, error } = await admin
    .from("conversations")
    .update({ snoozed_until: a.until.toISOString(), snoozed_by: a.userId })
    .eq("org_id", a.orgId)
    .eq("id", a.conversationId)
    .neq("status", "closed")
    .select("id")
    .maybeSingle();
  if (error || !data) return false;
  await scheduleJob({
    kind: "inbox.unsnooze",
    orgId: a.orgId,
    runAt: a.until,
    payload: { conversation_id: a.conversationId, until: a.until.toISOString() },
    dedupeKey: unsnoozeDedupeKey(a.conversationId, a.until),
  });
  return true;
}

export async function clearSnooze(
  admin: AdminClient,
  a: { orgId: string; conversationId: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from("conversations")
    .update({ snoozed_until: null, snoozed_by: null })
    .eq("org_id", a.orgId)
    .eq("id", a.conversationId)
    .not("snoozed_until", "is", null)
    .select("id")
    .maybeSingle();
  return !error && !!data;
}

const unsnoozePayload = z.object({ conversation_id: z.string().uuid(), until: z.string().min(1) });

/** The inbox.unsnooze job: brings the conversation back to the working folders (Waiting becomes Open). */
export async function handleUnsnooze(
  admin: AdminClient,
  orgId: string,
  payload: unknown,
): Promise<string> {
  const p = unsnoozePayload.safeParse(payload);
  if (!p.success) throw new PermanentJobError("invalid inbox.unsnooze payload");
  const until = new Date(p.data.until);
  if (Number.isNaN(until.getTime())) throw new PermanentJobError("invalid inbox.unsnooze time");
  const { data: conv } = await admin
    .from("conversations")
    .select("id, status, snoozed_until")
    .eq("org_id", orgId)
    .eq("id", p.data.conversation_id)
    .maybeSingle();
  if (!conv || !conv.snoozed_until) return "not_snoozed";
  if (new Date(conv.snoozed_until).getTime() !== until.getTime()) return "stale";
  // Claim: only the update that still sees this snooze clears it.
  const { data: won } = await admin
    .from("conversations")
    .update({
      snoozed_until: null,
      snoozed_by: null,
      ...(conv.status === "waiting" ? { status: "open" } : {}),
    })
    .eq("org_id", orgId)
    .eq("id", conv.id)
    .eq("snoozed_until", conv.snoozed_until)
    .select("id")
    .maybeSingle();
  return won ? "woken" : "already";
}
