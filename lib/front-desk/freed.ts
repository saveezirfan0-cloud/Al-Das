import "server-only";

import type { FreedSlot } from "@/lib/front-desk/waitlist";
import { scheduleJob } from "@/lib/jobs/enqueue";
import { redactText } from "@/lib/redact";

export type FreedSlotPayload = FreedSlot & { source_appointment_id: string | null };

/**
 * Durable trigger: called when an appointment is cancelled or moved away from a slot. Cheap (one scheduled_jobs
 * row); the work happens in the job. The slot travels in the payload because a moved appointment no longer
 * holds the time it gave back.
 */
export async function scheduleSlotFreed(
  orgId: string,
  slot: FreedSlotPayload,
  now: Date = new Date(),
): Promise<void> {
  try {
    await scheduleJob({
      kind: "waitlist.freed",
      orgId,
      runAt: now,
      payload: { ...slot },
      dedupeKey: `waitlist-freed:${slot.specialist_id}:${slot.starts_at}:${slot.source_appointment_id ?? "-"}`,
    });
  } catch (e) {
    // Never fail a cancellation because the waitlist could not be told.
    console.error("[waitlist] could not schedule the freed-slot job", redactText(e));
  }
}

/** The slot an appointment row gives back, or null when it cannot be offered (no doctor or place) or is in the past. */
export function freedSlotFromRow(
  row: {
    id: string;
    specialist_id: string | null;
    location_id: string | null;
    service_id: string | null;
    starts_at: string;
    ends_at: string;
  },
  now: Date = new Date(),
): FreedSlotPayload | null {
  if (!row.specialist_id || !row.location_id) return null;
  if (new Date(row.starts_at).getTime() <= now.getTime()) return null;
  return {
    source_appointment_id: row.id,
    specialist_id: row.specialist_id,
    location_id: row.location_id,
    service_id: row.service_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
  };
}
