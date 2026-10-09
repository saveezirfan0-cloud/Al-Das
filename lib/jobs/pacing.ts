/**
 * Pacing for sends held back by the per-number rate limit (claim_send_slot).
 *
 * A saturated message used to re-queue itself every second and gave up after 600
 * attempts (10 minutes). A 20,000-recipient campaign at the default 20 msg/s needs
 * ~17 minutes, so the tail of the list would have failed and the backlog would
 * have been re-read every second. Now: back off with jitter as the wait grows, and
 * expire by message age rather than attempt count.
 */

/**
 * Bulk sends (campaigns, automations: the `outbound` lane) may use at most this share of a
 * number's per-second limit, leaving headroom so live chat (`outbound_priority`) is never
 * starved by a long campaign.
 */
export const BULK_SHARE = 0.8;

export function bulkSlotCap(limitPerSec: number): number {
  return Math.max(1, Math.floor(limitPerSec * BULK_SHARE));
}

/** A message that has waited this long for a send slot is failed instead of sent very late. */
export const MAX_SLOT_WAIT_MS = 6 * 60 * 60 * 1000;

/** Longest base wait between tries. Higher cuts re-read churn on huge backlogs; lower shortens the tail of a run. */
export const MAX_BASE_DELAY_SECONDS = 10;

export function slotRetryDelaySeconds(attempt: number, rand: () => number = Math.random): number {
  const base = Math.min(MAX_BASE_DELAY_SECONDS, 1 + Math.floor(Math.max(0, attempt) / 5));
  const jitter = Math.floor(rand() * Math.max(1, Math.ceil(base / 2)));
  return base + jitter;
}

export function slotWaitExpired(
  messageAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!messageAt) return false;
  const t = Date.parse(messageAt);
  return Number.isFinite(t) && now - t > MAX_SLOT_WAIT_MS;
}
