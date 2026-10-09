/**
 * Auto-pause guardrails. A campaign pauses itself (and notifies the team) when
 * continuing would damage the number's standing with Meta. Pure; unit-tested.
 */
import { DEFAULT_GUARDRAILS, type Guardrails } from "@/lib/campaigns/constants";
import { mapMetaError } from "@/lib/whatsapp/errors";

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

/** Reads a stored guardrails object, filling gaps with defaults and bounding every value. */
export function parseGuardrails(raw: unknown): Guardrails {
  const o =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    max_failure_pct: clamp(o.max_failure_pct, 1, 100, DEFAULT_GUARDRAILS.max_failure_pct),
    max_total_failure_pct: clamp(
      o.max_total_failure_pct,
      1,
      100,
      DEFAULT_GUARDRAILS.max_total_failure_pct,
    ),
    min_sample: clamp(o.min_sample, 5, 10_000, DEFAULT_GUARDRAILS.min_sample),
    pause_on_quality_drop:
      typeof o.pause_on_quality_drop === "boolean"
        ? o.pause_on_quality_drop
        : DEFAULT_GUARDRAILS.pause_on_quality_drop,
  };
}

const QUALITY_RANK: Record<string, number> = { GREEN: 3, YELLOW: 2, RED: 1 };

/** Higher is better; null when Meta has not rated the number. */
export function qualityRank(q: string | null | undefined): number | null {
  return q ? (QUALITY_RANK[q.toUpperCase()] ?? null) : null;
}

export type GuardrailInput = {
  guardrails: Guardrails;
  /** Messages sent since the guard window opened (campaign start or last resume). */
  sentSince: number;
  /** Failed recipients since then, grouped by Meta error code. */
  failedByCode: Array<{ code: number | null; count: number }>;
  channel: { status: string; quality_rating: string | null };
  qualityAtStart: string | null;
  template: { status: string };
};

export type GuardrailVerdict =
  | { pause: false }
  | {
      pause: true;
      code:
        | "channel_inactive"
        | "template_unavailable"
        | "account_errors"
        | "quality_drop"
        | "failure_spike"
        | "bad_list";
      reason: string;
    };

export function evaluateGuardrails(input: GuardrailInput): GuardrailVerdict {
  const { guardrails: g } = input;

  if (input.channel.status !== "active")
    return {
      pause: true,
      code: "channel_inactive",
      reason: "The WhatsApp number is paused or disconnected.",
    };
  if (input.template.status !== "APPROVED")
    return {
      pause: true,
      code: "template_unavailable",
      reason: `The template is ${input.template.status}, not APPROVED.`,
    };

  let failed = 0;
  let systemic = 0;
  let accountLevel = 0;
  for (const f of input.failedByCode) {
    const mapped = mapMetaError(f.code);
    failed += f.count;
    if (mapped.category === "auth" || mapped.category === "account") accountLevel += f.count;
    if (mapped.category !== "recipient") systemic += f.count;
  }

  // Token or account problems never fix themselves: stop after a handful.
  if (accountLevel >= 3)
    return {
      pause: true,
      code: "account_errors",
      reason: `${accountLevel} sends failed with authentication or account errors. Check Settings → Channels.`,
    };

  if (g.pause_on_quality_drop) {
    const now = qualityRank(input.channel.quality_rating);
    const start = qualityRank(input.qualityAtStart);
    if (now !== null && ((start !== null && now < start) || (start === null && now === 1)))
      return {
        pause: true,
        code: "quality_drop",
        reason: `The number's quality rating dropped to ${input.channel.quality_rating}${
          input.qualityAtStart ? ` (was ${input.qualityAtStart})` : ""
        }.`,
      };
  }

  const outcomes = input.sentSince + failed;
  if (outcomes >= g.min_sample) {
    const systemicPct = (systemic / outcomes) * 100;
    if (systemicPct >= g.max_failure_pct)
      return {
        pause: true,
        code: "failure_spike",
        reason: `${Math.round(systemicPct)}% of the last ${outcomes} sends failed (limit ${g.max_failure_pct}%).`,
      };
    const totalPct = (failed / outcomes) * 100;
    if (totalPct >= g.max_total_failure_pct)
      return {
        pause: true,
        code: "bad_list",
        reason: `${Math.round(totalPct)}% of the last ${outcomes} recipients could not be reached (limit ${g.max_total_failure_pct}%). Check the audience.`,
      };
  }
  return { pause: false };
}
