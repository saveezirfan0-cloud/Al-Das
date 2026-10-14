/**
 * Per-template delivery settings (Phase 20d, pure; unit-tested): retry-on-fail, SMS fallback and message TTL.
 *
 *  - Retry-on-fail: a NON-campaign template message that failed with a retryable Meta code is copied once and
 *    sent again later, at most TEMPLATE_RETRY_MAX times along one chain, never after its TTL. Campaigns keep their
 *    own retry rounds (lib/campaigns/engine.ts) and are never retried here.
 *  - SMS fallback: only the Phase 19a reminder path sends SMS; this switch can only NARROW it, per template.
 *    A MARKETING template (or an unknown category) never falls back.
 *  - TTL: a template message that is older than its template's ttl_seconds when the outbound job reaches it is
 *    not sent at all (the patient would get a stale message). Measured from the first queueing of the chain.
 */
import { z } from "zod";

import { retryableErrorCodes } from "@/lib/whatsapp/errors";

/** Retries after the first failure: 10 minutes, then 1 hour. */
export const TEMPLATE_RETRY_DELAYS_SECONDS = [10 * 60, 60 * 60] as const;
export const TEMPLATE_RETRY_MAX = TEMPLATE_RETRY_DELAYS_SECONDS.length;

export const TTL_MIN_SECONDS = 60;
export const TTL_MAX_SECONDS = 30 * 86_400;

/** Pulse-internal code for "not sent: older than the template's time limit" (not a Meta code). */
export const TTL_EXPIRED_CODE = -2;

export const deliverySettingsSchema = z.object({
  retry_on_fail: z.boolean(),
  sms_fallback: z.boolean(),
  ttl_seconds: z.number().int().min(TTL_MIN_SECONDS).max(TTL_MAX_SECONDS).nullable(),
});
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;

/** Presets offered in the UI (seconds). A custom number of minutes is also accepted. */
export const TTL_PRESETS: ReadonlyArray<{ seconds: number | null; label: string }> = [
  { seconds: null, label: "No limit" },
  { seconds: 15 * 60, label: "15 minutes" },
  { seconds: 60 * 60, label: "1 hour" },
  { seconds: 6 * 3600, label: "6 hours" },
  { seconds: 12 * 3600, label: "12 hours" },
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 3 * 86_400, label: "3 days" },
];

export function describeTtl(seconds: number | null | undefined): string {
  if (!seconds) return "No limit";
  const preset = TTL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${Math.round(seconds / 60)} minutes`;
}

const RETRYABLE: ReadonlySet<number> = new Set(retryableErrorCodes());

/** Is a failure with this code worth sending again later? (Same list the campaign retry rounds use.) */
export function isRetryableCode(code: number | null | undefined): boolean {
  return typeof code === "number" && RETRYABLE.has(code);
}

/** True when a message first queued at `originAt` may no longer be sent under a TTL of `ttlSeconds`. */
export function isTtlExpired(
  originAt: string | Date | null | undefined,
  ttlSeconds: number | null | undefined,
  now: Date,
): boolean {
  if (!ttlSeconds || ttlSeconds <= 0 || !originAt) return false;
  const t = typeof originAt === "string" ? Date.parse(originAt) : originAt.getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t > ttlSeconds * 1000;
}

export type RetrySkipReason =
  | "off"
  | "not_template"
  | "campaign"
  | "authentication"
  | "not_retryable"
  | "exhausted"
  | "expired";

export type RetryDecision =
  | { retry: true; attempt: number; delaySeconds: number }
  | { retry: false; reason: RetrySkipReason };

/**
 * Should this failed message be sent again? `previousRetries` is the failed message's own place in the chain
 * (0 = the original). The TTL is checked against the moment the retry would actually go out.
 */
export function templateRetryDecision(input: {
  retryOnFail: boolean | null | undefined;
  isTemplate: boolean;
  campaignRecipientId: string | null | undefined;
  /** An Authentication (code) template is never re-sent: the code would be stale. */
  category?: string | null;
  errorCode: number | null | undefined;
  previousRetries: number;
  ttlSeconds: number | null | undefined;
  originAt: string | Date | null | undefined;
  now: Date;
}): RetryDecision {
  if (!input.isTemplate) return { retry: false, reason: "not_template" };
  if (input.campaignRecipientId) return { retry: false, reason: "campaign" };
  if ((input.category ?? "").toUpperCase() === "AUTHENTICATION")
    return { retry: false, reason: "authentication" };
  if (input.retryOnFail !== true) return { retry: false, reason: "off" };
  if (!isRetryableCode(input.errorCode)) return { retry: false, reason: "not_retryable" };
  const done = Math.max(0, Math.floor(input.previousRetries));
  if (done >= TEMPLATE_RETRY_MAX) return { retry: false, reason: "exhausted" };
  const delaySeconds = TEMPLATE_RETRY_DELAYS_SECONDS[done]!;
  const sendAt = new Date(input.now.getTime() + delaySeconds * 1000);
  if (isTtlExpired(input.originAt, input.ttlSeconds, sendAt))
    return { retry: false, reason: "expired" };
  return { retry: true, attempt: done + 1, delaySeconds };
}

/** Categories whose messages are transactional enough for an SMS fallback. Fails closed on anything else. */
const SMS_FALLBACK_CATEGORIES: ReadonlySet<string> = new Set(["UTILITY", "AUTHENTICATION"]);

/** May a failed message of this template fall back to SMS (Phase 19a reminder path)? Never for marketing. */
export function smsFallbackAllowed(template: {
  category: string | null | undefined;
  sms_fallback: boolean | null | undefined;
}): boolean {
  const category = (template.category ?? "").toUpperCase();
  return SMS_FALLBACK_CATEGORIES.has(category) && template.sms_fallback !== false;
}

/** What the retry chain carries in messages.payload.retry (ids and times only). */
export type RetryMarker = { attempt: number; origin_at: string };

export function readRetryMarker(payload: unknown): RetryMarker | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const r = (payload as Record<string, unknown>).retry;
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const attempt = Number((r as Record<string, unknown>).attempt);
  const origin = (r as Record<string, unknown>).origin_at;
  if (!Number.isInteger(attempt) || attempt < 1 || typeof origin !== "string") return null;
  return { attempt, origin_at: origin };
}
