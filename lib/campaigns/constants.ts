/**
 * Campaign constants and status helpers. Framework-free: shared by the job
 * handlers, server actions, UI and tests.
 */

export const CAMPAIGN_STATUSES = [
  "preparing",
  "scheduled",
  "queued",
  "sending",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  "pending",
  "queued",
  "sent",
  "delivered",
  "read",
  "failed",
  "skipped",
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

/** Hard cap on one campaign's audience (keeps snapshot + report within one request). */
export const MAX_RECIPIENTS = 50_000;
/** Recipients dispatched per fanout batch (one campaign_dispatch call). */
export const DISPATCH_BATCH = 200;
/** Queued-but-unsent messages a campaign may have in the outbound queue at once. */
export const MAX_IN_FLIGHT = 400;
/** A fanout invocation stops dispatching after this long and re-enqueues itself. */
export const FANOUT_BUDGET_MS = 40_000;
/** A patient message this soon after a campaign message counts as a reply. */
export const REPLY_WINDOW_DAYS = 7;
/** Campaign messages still 'queued' after this long are re-pushed to the outbound queue. */
export const STUCK_MESSAGE_MINUTES = 10;

export type Guardrails = {
  /** Pause when systemic failures (not the recipient's fault) reach this share of outcomes. */
  max_failure_pct: number;
  /** Pause when all failures together reach this share of outcomes (a bad list hurts quality). */
  max_total_failure_pct: number;
  /** Outcomes (sent + failed) needed before the percentages apply. */
  min_sample: number;
  /** Pause when the number's quality rating drops below where it was at the start. */
  pause_on_quality_drop: boolean;
};

export const DEFAULT_GUARDRAILS: Guardrails = {
  max_failure_pct: 15,
  max_total_failure_pct: 40,
  min_sample: 50,
  pause_on_quality_drop: true,
};

const IS_ACTIVE: ReadonlySet<CampaignStatus> = new Set([
  "scheduled",
  "queued",
  "sending",
  "paused",
]);

/** Campaigns the tick still has to look at. */
export function isActiveStatus(s: CampaignStatus): boolean {
  return IS_ACTIVE.has(s);
}

export function canPause(s: CampaignStatus): boolean {
  return s === "queued" || s === "sending";
}
export function canResume(s: CampaignStatus): boolean {
  return s === "paused";
}
export function canCancel(s: CampaignStatus): boolean {
  return s === "scheduled" || s === "queued" || s === "sending" || s === "paused";
}
export function canStartNow(s: CampaignStatus): boolean {
  return s === "scheduled";
}
export function canReschedule(s: CampaignStatus): boolean {
  return s === "scheduled";
}
export function canDelete(s: CampaignStatus): boolean {
  return s === "cancelled" || s === "failed" || s === "completed" || s === "preparing";
}

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  preparing: "Preparing",
  scheduled: "Scheduled",
  queued: "Queued",
  sending: "Sending",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const SKIP_REASON_LABEL: Record<string, string> = {
  deleted: "Contact deleted",
  not_found: "Contact not found",
  no_destination: "No WhatsApp phone or user id",
  stop_marketing: "Opted out of marketing",
  no_opt_in: "No marketing opt-in",
  missing_variable: "Missing template value",
  channel_inactive: "Number paused",
  cancelled: "Campaign cancelled",
};

export function skipReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  const [head, ...rest] = reason.split(":");
  const base = SKIP_REASON_LABEL[head] ?? head;
  return rest.length ? `${base} (${rest.join(":")})` : base;
}

/** Meta's business-initiated conversation tiers → unique contacts per rolling 24 h (null = unlimited/unknown). */
export function tierDailyLimit(tier: string | null | undefined): number | null {
  switch (tier) {
    case "TIER_250":
      return 250;
    case "TIER_1K":
      return 1_000;
    case "TIER_2K":
      return 2_000;
    case "TIER_10K":
      return 10_000;
    case "TIER_100K":
      return 100_000;
    default:
      return null;
  }
}
