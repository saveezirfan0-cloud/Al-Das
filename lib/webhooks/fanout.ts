import "server-only";

import { randomUUID } from "node:crypto";

import type { DomainEvent } from "@/lib/events/emit";
import { enqueue } from "@/lib/jobs/enqueue";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";
import { isWebhookEvent } from "@/lib/webhooks/events";
import { buildEnvelope } from "@/lib/webhooks/payload";

/** Which active subscriptions want this event. Pure, so the rule is testable without a database. */
export function matchingSubscriptions<T extends { id: string; events: string[]; active: boolean }>(subs: T[], eventName: string): T[] {
  return subs.filter((s) => s.active && s.events.includes(eventName));
}

/**
 * Turns one domain event into delivery rows (one per matching subscription) and queues them on
 * webhooks_out. Called straight from emit() rather than registered as a listener: listeners are
 * per-process, and on serverless the process that emits is not the one that registered it.
 *
 * Idempotent per (subscription, event): the unique constraint makes a repeat a no-op. Returns how
 * many deliveries were queued. Never throws into the emitter (emit() also guards it).
 */
export async function fanoutEvent(event: DomainEvent, admin: AdminClient = createAdminClient()): Promise<number> {
  if (!isWebhookEvent(event.name)) return 0;
  const { data: subs, error } = await admin
    .from("webhook_subscriptions")
    .select("id, events, active")
    .eq("org_id", event.orgId)
    .eq("active", true);
  if (error) throw new Error(`webhook subscription lookup failed (${error.code ?? "unknown"})`);
  const targets = matchingSubscriptions(subs ?? [], event.name);
  if (targets.length === 0) return 0;

  const eventId = randomUUID();
  const envelope = buildEnvelope({ id: eventId, type: event.name, orgId: event.orgId, createdAt: event.at, payload: event.payload });
  const { data: created, error: insertError } = await admin
    .from("webhook_deliveries")
    .upsert(
      targets.map((t) => ({
        org_id: event.orgId,
        subscription_id: t.id,
        event_id: eventId,
        event: event.name,
        payload: envelope as unknown as NonNullable<Json>,
        status: "pending" as const,
      })),
      { onConflict: "subscription_id,event_id", ignoreDuplicates: true },
    )
    .select("id");
  if (insertError) throw new Error(`webhook delivery insert failed (${insertError.code ?? "unknown"})`);

  for (const d of created ?? []) await enqueue("webhooks_out", { delivery_id: d.id });
  return created?.length ?? 0;
}
