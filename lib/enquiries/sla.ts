import type { EnquiryStatus } from "@/lib/enquiries/constants";

/** Pipeline override wins over the org default; null = no SLA. */
export function resolveSlaMinutes(
  pipelineMinutes: number | null | undefined,
  orgDefaultMinutes: number | null | undefined,
): number | null {
  const v = pipelineMinutes ?? orgDefaultMinutes ?? null;
  return v && v > 0 ? v : null;
}

/** When the first touch is due; null when there is no SLA. */
export function computeSlaDueAt(createdAt: Date, minutes: number | null): Date | null {
  if (!minutes || minutes <= 0) return null;
  return new Date(createdAt.getTime() + minutes * 60_000);
}

export type SlaState = "none" | "met" | "ok" | "due_soon" | "breached";

/**
 * "met" = touched before (or at) the deadline; "breached" = past the deadline
 * without a touch (or touched late); "due_soon" = under 20% of the window left.
 * Closed enquiries have no live SLA.
 */
export function slaState(
  e: {
    status: EnquiryStatus;
    sla_due_at: string | Date | null;
    first_touch_at: string | Date | null;
    created_at: string | Date;
  },
  now: Date,
): SlaState {
  if (!e.sla_due_at) return "none";
  const due = new Date(e.sla_due_at).getTime();
  if (e.first_touch_at) return new Date(e.first_touch_at).getTime() <= due ? "met" : "breached";
  if (e.status !== "open") return "none";
  if (now.getTime() > due) return "breached";
  const window = due - new Date(e.created_at).getTime();
  return due - now.getTime() <= window * 0.2 ? "due_soon" : "ok";
}

/** Should the SLA job raise a breach now? Idempotent: only if still untouched, open and not yet raised. */
export function shouldRaiseBreach(
  e: {
    status: EnquiryStatus;
    deleted_at: string | null;
    sla_due_at: string | Date | null;
    first_touch_at: string | Date | null;
    sla_breached_at: string | Date | null;
  },
  now: Date,
): boolean {
  if (e.deleted_at || e.status !== "open") return false;
  if (!e.sla_due_at || e.first_touch_at || e.sla_breached_at) return false;
  return new Date(e.sla_due_at).getTime() <= now.getTime();
}
