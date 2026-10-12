import { topicFor } from "@/lib/push/endpoint";
import type { PushSender, PushSubscriptionData } from "@/lib/push/types";
import { buildPushPayload, type PushIds } from "@/lib/notify/push-payload";

/** A device row as the delivery code needs it. subscription_enc is AES-256-GCM ciphertext. */
export type StoredSubscription = { id: string; subscription_enc: string; failure_count: number };

export type PushStore = {
  list(orgId: string, userId: string): Promise<StoredSubscription[]>;
  remove(id: string): Promise<void>;
  /** ok = delivered: resets the failure count and stamps last_used_at. Not ok: counts one failure. */
  record(id: string, ok: boolean, failureCount: number): Promise<void>;
};

export type PushJob = {
  org_id: string;
  user_id: string;
  event: string;
  ids?: PushIds;
};

export type PushOutcome = {
  sent: number;
  removed: number;
  failed: number;
  skipped: "no_payload" | "no_devices" | null;
};

/** After this many failures in a row (other than 404/410) a device is dropped; it can register again. */
export const MAX_CONSECUTIVE_FAILURES = 10;

export async function deliverPush(
  deps: { store: PushStore; sender: PushSender; decrypt: (blob: string) => PushSubscriptionData },
  job: PushJob,
): Promise<PushOutcome> {
  const payload = buildPushPayload(job.event, job.ids ?? {});
  if (!payload) return { sent: 0, removed: 0, failed: 0, skipped: "no_payload" };
  const devices = await deps.store.list(job.org_id, job.user_id);
  if (devices.length === 0) return { sent: 0, removed: 0, failed: 0, skipped: "no_devices" };

  const body = JSON.stringify(payload);
  const outcome: PushOutcome = { sent: 0, removed: 0, failed: 0, skipped: null };
  for (const device of devices) {
    let subscription: PushSubscriptionData;
    try {
      subscription = deps.decrypt(device.subscription_enc);
    } catch {
      // Undecryptable (ENCRYPTION_KEY changed): useless to keep.
      await deps.store.remove(device.id);
      outcome.removed++;
      continue;
    }
    const result = await deps.sender.send(subscription, body, {
      ttl: job.event === "escalation" ? 3600 : 900,
      urgency: job.event === "escalation" || job.event === "inbox.message" ? "high" : "normal",
      topic: topicFor(payload.tag),
    });
    if (result.ok) {
      await deps.store.record(device.id, true, 0);
      outcome.sent++;
    } else if (result.gone) {
      await deps.store.remove(device.id);
      outcome.removed++;
    } else {
      const failures = device.failure_count + 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        await deps.store.remove(device.id);
        outcome.removed++;
      } else {
        await deps.store.record(device.id, false, failures);
        outcome.failed++;
      }
    }
  }
  return outcome;
}
