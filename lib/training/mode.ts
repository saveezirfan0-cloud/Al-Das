import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";
import { simulatedWaMessageId, TRAINING_BLOCKED_MESSAGE } from "@/lib/training/simulate";

export { TRAINING_BLOCKED_MESSAGE, simulatedWaMessageId };

/** Thrown by anything that is about to call Meta from a training workspace. */
export class TrainingModeError extends Error {
  constructor(message = TRAINING_BLOCKED_MESSAGE) {
    super(message);
    this.name = "TrainingModeError";
  }
}

/** True when the org is a training sandbox (orgs.is_training). Fails SAFE: an unreadable flag counts as not training. */
export async function isTrainingOrg(admin: AdminClient, orgId: string): Promise<boolean> {
  const { data } = await admin.from("orgs").select("is_training").eq("id", orgId).maybeSingle();
  return data?.is_training === true;
}

/** Throws TrainingModeError for a training org. Call before any Meta Graph request. */
export async function assertNotTraining(admin: AdminClient, orgId: string): Promise<void> {
  if (await isTrainingOrg(admin, orgId)) throw new TrainingModeError();
}

/**
 * A training send never leaves the building: the queued message is marked sent with a made-up id and flagged in
 * its payload, so the thread looks right on screen and no request is made to Meta. Idempotent (only a queued or
 * sending message is touched).
 */
export async function simulateTrainingSend(
  admin: AdminClient,
  message: { id: string; payload: unknown },
): Promise<void> {
  const base =
    message.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? (message.payload as Record<string, unknown>)
      : {};
  await admin
    .from("messages")
    .update({
      status: "sent",
      wa_message_id: simulatedWaMessageId(message.id),
      payload: { ...base, training: true } as never,
      error_code: null,
      error_message: null,
    })
    .eq("id", message.id)
    .in("status", ["queued", "sending"]);
}
