import "server-only";

import { decryptJson, encryptJson } from "@/lib/crypto";
import { endpointHash } from "@/lib/push/endpoint";
import type { PushStore } from "@/lib/push/deliver";
import type { PushSubscriptionData } from "@/lib/push/types";
import type { AdminClient } from "@/lib/supabase/admin";

/** Subscriptions live encrypted (AES-256-GCM with ENCRYPTION_KEY); only a hash of the endpoint is in clear. */
export function dbPushStore(admin: AdminClient): PushStore {
  return {
    async list(orgId, userId) {
      const { data } = await admin
        .from("push_subscriptions")
        .select("id, subscription_enc, failure_count")
        .eq("org_id", orgId)
        .eq("user_id", userId);
      return data ?? [];
    },
    async remove(id) {
      await admin.from("push_subscriptions").delete().eq("id", id);
    },
    async record(id, ok, failureCount) {
      await admin
        .from("push_subscriptions")
        .update(
          ok
            ? { failure_count: 0, last_used_at: new Date().toISOString() }
            : { failure_count: failureCount },
        )
        .eq("id", id);
    },
  };
}

export const decryptSubscription = (blob: string): PushSubscriptionData =>
  decryptJson<PushSubscriptionData>(blob);

/** Registers (or refreshes) one device for one person in one org. Idempotent on the endpoint. */
export async function saveSubscription(
  admin: AdminClient,
  input: {
    orgId: string;
    userId: string;
    subscription: PushSubscriptionData;
    uaFamily: string | null;
  },
): Promise<void> {
  const { error } = await admin.from("push_subscriptions").upsert(
    {
      org_id: input.orgId,
      user_id: input.userId,
      endpoint_hash: endpointHash(input.subscription.endpoint),
      subscription_enc: encryptJson(input.subscription),
      ua_family: input.uaFamily,
      failure_count: 0,
    },
    { onConflict: "org_id,user_id,endpoint_hash" },
  );
  if (error) throw new Error(`could not save push subscription (${error.code ?? "unknown"})`);
}

export async function removeSubscription(
  admin: AdminClient,
  input: { orgId: string; userId: string; endpoint: string },
): Promise<void> {
  await admin
    .from("push_subscriptions")
    .delete()
    .eq("org_id", input.orgId)
    .eq("user_id", input.userId)
    .eq("endpoint_hash", endpointHash(input.endpoint));
}
