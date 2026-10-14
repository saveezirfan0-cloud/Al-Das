/**
 * First-response time on the conversation list (Phase F). Pure: shared by the list, the tests and the settings form.
 *
 * A conversation is "waiting" when the patient's last message has no reply after it: it is not closed, it has an
 * inbound message, and nothing went out since (last_outbound_at is older or missing). Internal notes are not replies.
 * The colour comes from the workspace's two thresholds (Settings in orgs.settings.inbox, defaults 15 and 60 minutes).
 */

export type SlaThresholds = { amberMinutes: number; redMinutes: number };

export const DEFAULT_SLA_THRESHOLDS: SlaThresholds = { amberMinutes: 15, redMinutes: 60 };

export type SlaLevel = "ok" | "amber" | "red";

export type WaitingConversation = {
  status: string;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
};

/** When the unanswered wait started (the patient's last message), or null if nobody is waiting for a reply. */
export function waitingSince(c: WaitingConversation): Date | null {
  if (c.status === "closed" || !c.last_inbound_at) return null;
  const inbound = new Date(c.last_inbound_at);
  if (Number.isNaN(inbound.getTime())) return null;
  if (c.last_outbound_at) {
    const outbound = new Date(c.last_outbound_at);
    if (!Number.isNaN(outbound.getTime()) && outbound.getTime() >= inbound.getTime()) return null;
  }
  return inbound;
}

/** Thresholds that make sense: both positive, red after amber. Anything else falls back to the defaults. */
export function normaliseThresholds(t: Partial<SlaThresholds> | null | undefined): SlaThresholds {
  const amber = Number(t?.amberMinutes);
  const red = Number(t?.redMinutes);
  if (!Number.isInteger(amber) || !Number.isInteger(red) || amber < 1 || red <= amber || red > 7 * 24 * 60)
    return DEFAULT_SLA_THRESHOLDS;
  return { amberMinutes: amber, redMinutes: red };
}

export type FirstResponse = { waitingMs: number; level: SlaLevel } | null;

export function firstResponse(
  c: WaitingConversation,
  now: Date,
  thresholds: SlaThresholds = DEFAULT_SLA_THRESHOLDS,
): FirstResponse {
  const since = waitingSince(c);
  if (!since) return null;
  const waitingMs = Math.max(0, now.getTime() - since.getTime());
  const t = normaliseThresholds(thresholds);
  const minutes = waitingMs / 60_000;
  const level: SlaLevel = minutes >= t.redMinutes ? "red" : minutes >= t.amberMinutes ? "amber" : "ok";
  return { waitingMs, level };
}

/** "waiting 12 m", "waiting 3 h", "waiting 2 d" (whole units, rounded down; under a minute is "1 m"). */
export function formatWaiting(ms: number): string {
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}
