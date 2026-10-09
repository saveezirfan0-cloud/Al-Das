import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/types";

export type TimelineEntry = {
  orgId: string;
  contactId: string;
  /** Set for enquiry events so they also show on the enquiry's own timeline. */
  enquiryId?: string | null;
  type: string;
  actorType?: "user" | "system" | "contact" | "job";
  actorId?: string | null;
  payload?: Json;
};

/** Appends one timeline event. Failures are logged, never thrown (the main action already happened). */
export async function addTimelineEvent(admin: AdminClient, e: TimelineEntry): Promise<void> {
  const { error } = await admin.from("timeline_events").insert({
    org_id: e.orgId,
    contact_id: e.contactId,
    enquiry_id: e.enquiryId ?? null,
    type: e.type,
    actor_type: e.actorType ?? "user",
    actor_id: e.actorId ?? null,
    payload: e.payload ?? {},
  });
  if (error) console.error("[timeline] insert failed", { type: e.type, code: error.code });
}

/** Field-level diff of two contact-ish objects: { field: { from, to } } for changed keys. */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (!(k in after)) continue;
    const a = before[k] ?? null;
    const b = after[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = { from: a, to: b };
  }
  return out;
}
